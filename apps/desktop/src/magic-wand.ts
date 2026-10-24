import {
  mapCutsToOutput,
  planMagicWandCuts,
  type MagicSourceInput,
  type MagicWandPreset,
} from "../../../packages/domain/src/magic-wand.ts";
import {
  assertMagicWandView,
  idleMagicWandView,
  magicWandIssues,
  type MagicWandView,
} from "../../../packages/domain/src/magic-wand-view.ts";
import {
  analyzeSpokenCandidates,
  createDefaultSpokenCandidatePolicy,
} from "../../../packages/domain/src/spoken-candidates.ts";
import type {
  TranscriptionJobRequest,
  TranscriptionProjectRequest,
  TranscriptionProjectView,
} from "../../../packages/domain/src/transcription.ts";
import {
  roughCutRequest,
  type RoughCutEvidence,
} from "./rough-cut-playbook.ts";

type Transcriptions = {
  get(request: TranscriptionJobRequest): Promise<TranscriptionProjectView>;
  start(
    request: TranscriptionProjectRequest,
  ): Promise<TranscriptionProjectView>;
};

/** Calls one guarded editor tool as the Magic Wand origin for a project. */
type ToolInvoker = (
  projectId: string,
  name: string,
  input: unknown,
) => Promise<unknown>;

/** How a rough-cut run by Claude ended, as Magic Edit reports it. */
export type RoughCutOutcome =
  "completed" | "stopped" | "signIn" | "limit" | "failed";

/** The assistant that makes the rough cut; main backs it with Claude. */
export interface RoughCutEditor {
  /** Starts the run, or returns the reason it cannot start. */
  start(
    projectId: string,
    preset: MagicWandPreset,
    request: string,
  ): Promise<RoughCutOutcome | null>;
  /** Null while the run is going, then how it ended. */
  outcome(projectId: string): RoughCutOutcome | null;
  stop(projectId: string): Promise<void>;
}

interface DraftSummary {
  draft_id: string;
  base_revision_id: string;
  draft_sequence: number;
  timeline_sha256: string;
  duration_us: number;
  operation_ids: string[];
  clips: {
    source_id: string;
    source_start_us: number;
    source_end_us: number;
    timeline_start_us: number;
    timeline_end_us: number;
    speed?: number;
  }[];
}

interface Job {
  projectId: string;
  preset: MagicWandPreset;
  stop: boolean;
}

function draftOf(value: unknown): DraftSummary {
  const record = value as { draft?: DraftSummary } & DraftSummary;
  const draft = record.draft ?? record;
  if (
    !draft ||
    typeof draft.draft_sequence !== "number" ||
    !Array.isArray(draft.clips)
  )
    throw new Error("Unexpected draft summary");
  return draft;
}

/**
 * Main-owned Magic Edit: the rough cut. Main transcribes locally and finds
 * pauses, fillers and repeated wording; Claude then makes the story edit
 * through the guarded cutting tools, using that analysis only as evidence.
 * Nothing is cut mechanically. One run per project; Stop stops Claude's turn
 * and every committed cut stays undoable.
 */
export class DesktopMagicWand {
  private readonly transcriptions: Transcriptions;
  private readonly invoke: ToolInvoker;
  private readonly editor: RoughCutEditor;
  private readonly views = new Map<string, MagicWandView>();
  private readonly jobs = new Map<string, Job>();
  private readonly pollMs: number;

  constructor(
    transcriptions: Transcriptions,
    invoke: ToolInvoker,
    editor: RoughCutEditor,
    options: { pollMs?: number } = {},
  ) {
    this.transcriptions = transcriptions;
    this.invoke = invoke;
    this.editor = editor;
    this.pollMs = options.pollMs ?? 500;
  }

  get(projectId: string): MagicWandView {
    const value = structuredClone(
      this.views.get(projectId) ?? idleMagicWandView(),
    );
    assertMagicWandView(value);
    return value;
  }

  busy(projectId: string): boolean {
    return this.jobs.has(projectId);
  }

  private set(projectId: string, view: MagicWandView): void {
    assertMagicWandView(view);
    this.views.set(projectId, view);
  }

  start(projectId: string, preset: MagicWandPreset): MagicWandView {
    if (this.jobs.has(projectId)) return this.get(projectId);
    const job: Job = { projectId, preset, stop: false };
    this.jobs.set(projectId, job);
    this.set(projectId, {
      status: "transcribing",
      projectId,
      preset,
      progress: 0,
      summary: null,
      message: null,
    });
    void this.run(job).finally(() => this.jobs.delete(projectId));
    return this.get(projectId);
  }

  stop(projectId: string): MagicWandView {
    const job = this.jobs.get(projectId);
    if (job) {
      job.stop = true;
      if (this.get(projectId).status === "applying")
        void this.editor.stop(projectId).catch(() => undefined);
    }
    return this.get(projectId);
  }

  /** Forgets a finished run when its project closes. */
  closeProject(projectId: string): void {
    if (!this.jobs.has(projectId)) this.views.delete(projectId);
  }

  private end(
    job: Job,
    status: "completed" | "stopped" | "failed",
    message: string | null,
    change: { removedUs: number; cuts: number } | null,
  ): void {
    this.set(job.projectId, {
      status,
      projectId: job.projectId,
      preset: job.preset,
      progress: null,
      // Measured from the draft: what Claude's committed cuts removed.
      summary:
        !change || (status === "failed" && change.cuts === 0)
          ? null
          : {
              removedUs: change.removedUs,
              cuts: change.cuts,
              pauses: 0,
              fillers: 0,
              repeatedTakes: 0,
              leftForReview: 0,
            },
      message,
    });
  }

  private async transcript(job: Job): Promise<TranscriptionProjectView | null> {
    const request = {
      schema_version: "1.0" as const,
      project_id: job.projectId,
    };
    let view = await this.transcriptions.get({ ...request, job_id: null });
    let started = false;
    for (;;) {
      if (job.stop) return null;
      const status = view.job.status;
      if (view.job.source_count === 0) throw new Error(magicWandIssues.noAudio);
      if (status === "completed") return view;
      if (
        ["failed", "cancelled"].includes(status) ||
        (status === "idle" && started)
      )
        throw new Error(magicWandIssues.transcription);
      if (status === "idle") {
        // Request a missing transcript once, then follow that job.
        view = await this.transcriptions.start(request);
        started = true;
        continue;
      }
      this.set(job.projectId, {
        ...this.get(job.projectId),
        progress: Math.min(
          1,
          Math.max(0, (view.job.progress_percent ?? 0) / 100),
        ),
      });
      await new Promise((resolve) => setTimeout(resolve, this.pollMs));
      view = await this.transcriptions.get({
        ...request,
        job_id: view.job.job_id,
      });
    }
  }

  private async run(job: Job): Promise<void> {
    const summary = { schema_version: "1.0", project_id: job.projectId };
    let before: DraftSummary | null = null;
    const change = async () => {
      if (!before) return null;
      const after = draftOf(
        await this.invoke(job.projectId, "timeline.get_summary", summary),
      );
      const known = new Set(before.operation_ids);
      return {
        removedUs: Math.max(0, before.duration_us - after.duration_us),
        cuts: after.operation_ids.filter((id) => !known.has(id)).length,
      };
    };
    try {
      const transcription = await this.transcript(job);
      if (!transcription) {
        this.end(job, "stopped", magicWandIssues.stopped, null);
        return;
      }
      const inputs: MagicSourceInput[] = transcription.results.map(
        (result) => ({
          sourceId: result.source_id,
          transcript: result.transcript,
          analysis: result.analysis,
          report: analyzeSpokenCandidates(
            result.transcript,
            result.analysis,
            createDefaultSpokenCandidatePolicy(result.transcript.language),
          ),
        }),
      );
      // Evidence for Claude, mapped onto the current edit; not cuts.
      const plan = planMagicWandCuts(inputs, job.preset);
      before = draftOf(
        await this.invoke(job.projectId, "timeline.get_summary", summary),
      );
      const clips = before.clips;
      const evidence: RoughCutEvidence[] = plan.cuts
        .flatMap((cut) =>
          mapCutsToOutput([cut], clips).flatMap((range) =>
            range.kinds.map((kind) => ({
              kind,
              sourceId: cut.sourceId,
              sourceStartUs: cut.startUs,
              sourceEndUs: cut.endUs,
              startUs: range.start_us,
              endUs: range.end_us,
            })),
          ),
        )
        .sort((a, b) => a.startUs - b.startUs);
      if (job.stop) {
        this.end(job, "stopped", magicWandIssues.stopped, null);
        return;
      }
      this.set(job.projectId, {
        ...this.get(job.projectId),
        status: "applying",
        progress: null,
      });
      const refused = await this.editor.start(
        job.projectId,
        job.preset,
        roughCutRequest(job.preset, evidence),
      );
      let outcome = refused;
      while (!outcome) {
        await new Promise((resolve) => setTimeout(resolve, this.pollMs));
        outcome = this.editor.outcome(job.projectId);
      }
      const changed = await change();
      if (outcome === "completed")
        this.end(
          job,
          "completed",
          changed?.cuts ? null : magicWandIssues.nothing,
          changed,
        );
      else if (outcome === "stopped")
        this.end(job, "stopped", magicWandIssues.stopped, changed);
      else
        this.end(
          job,
          "failed",
          outcome === "signIn"
            ? magicWandIssues.claude
            : outcome === "limit"
              ? magicWandIssues.limit
              : magicWandIssues.failed,
          changed,
        );
    } catch (error) {
      const message =
        error instanceof Error &&
        (error.message === magicWandIssues.noAudio ||
          error.message === magicWandIssues.transcription)
          ? error.message
          : magicWandIssues.failed;
      this.end(job, "failed", message, await change().catch(() => null));
    }
  }
}
