import {
  mapCutsToOutput,
  planMagicWandCuts,
  type MagicSourceInput,
  type MagicWandPreset,
} from "../../../packages/domain/src/magic-wand.ts";
import type { EnergyTrack } from "../../../packages/domain/src/audio-energy.ts";
import {
  assertMagicWandView,
  idleMagicWandView,
  magicWandIssues,
  magicWandSkipMessage,
  type MagicWandBlock,
  type MagicWandProvider,
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

/**
 * What the tightening step needs from main: the loudness of a recording and
 * one undoable transaction of ripple deletes (descending output ranges).
 */
export interface Tightener {
  energy(projectId: string, sourceId: string): Promise<EnergyTrack | null>;
  applyRanges(
    projectId: string,
    draft: DraftSummary,
    ranges: readonly { start_us: number; end_us: number }[],
  ): Promise<void>;
}

/** How the story edit by the chosen connection ended, as Magic Edit reports it. */
export type RoughCutOutcome =
  "completed" | "stopped" | "signIn" | "limit" | "failed";

/**
 * The assistant that makes the story edit; main backs it with the connection
 * the user chose (Claude, Codex or an API provider).
 */
export interface RoughCutEditor {
  /** Why this connection cannot make the story edit now, or null when it can. */
  blocked?(provider: MagicWandProvider): Promise<MagicWandBlock | null>;
  /** Starts the run, or returns the reason it cannot start. */
  start(
    projectId: string,
    preset: MagicWandPreset,
    request: string,
    provider?: MagicWandProvider,
  ): Promise<RoughCutOutcome | null>;
  /** Null while the run is going, then how it ended. */
  outcome(projectId: string): RoughCutOutcome | null;
  stop(projectId: string): Promise<void>;
  /** The run is over for Magic Edit: lift its tool restrictions. */
  release?(projectId: string): void;
}

export interface DraftSummary {
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

interface Tightened {
  pauses: number;
  fillers: number;
  leftForReview: number;
}

interface Job {
  projectId: string;
  preset: MagicWandPreset;
  provider: MagicWandProvider;
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
 * Main-owned Magic Edit: the rough cut. Main transcribes locally, finds
 * pauses, fillers and repeated wording and tightens them as one undoable
 * transaction; the chosen connection (Claude gives the best results, Codex
 * and the API providers work too) then makes the story edit through the
 * guarded cutting tools, using the rest of the analysis only as evidence.
 * When that connection cannot run, the tightening still stands and the
 * result says what was skipped and how to fix it. One run per project; Stop
 * stops the assistant's turn and every committed cut stays undoable.
 */
export class DesktopMagicWand {
  private readonly transcriptions: Transcriptions;
  private readonly invoke: ToolInvoker;
  private readonly editor: RoughCutEditor;
  private readonly views = new Map<string, MagicWandView>();
  private readonly jobs = new Map<string, Job>();
  private readonly pollMs: number;
  private readonly tightener: Tightener | null;

  constructor(
    transcriptions: Transcriptions,
    invoke: ToolInvoker,
    editor: RoughCutEditor,
    options: { pollMs?: number; tightener?: Tightener } = {},
  ) {
    this.tightener = options.tightener ?? null;
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

  start(
    projectId: string,
    preset: MagicWandPreset,
    provider: MagicWandProvider = "claude",
  ): MagicWandView {
    if (this.jobs.has(projectId)) return this.get(projectId);
    const job: Job = { projectId, preset, provider, stop: false };
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
    tightened: Tightened | null = null,
  ): void {
    this.set(job.projectId, {
      status,
      projectId: job.projectId,
      preset: job.preset,
      progress: null,
      // Measured from the draft: what the committed cuts removed.
      summary:
        !change || (status === "failed" && change.cuts === 0 && !tightened)
          ? null
          : {
              removedUs: change.removedUs,
              cuts: change.cuts,
              pauses: tightened?.pauses ?? 0,
              fillers: tightened?.fillers ?? 0,
              repeatedTakes: 0,
              leftForReview: tightened?.leftForReview ?? 0,
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
      // The loudness of each recording confirms and places every pause cut.
      const energy = new Map<string, EnergyTrack>();
      if (this.tightener)
        for (const input of inputs) {
          if (job.stop) break;
          const track = await this.tightener
            .energy(job.projectId, input.sourceId)
            .catch(() => null);
          if (track) energy.set(input.sourceId, track);
        }
      const plan = planMagicWandCuts(inputs, job.preset, energy);
      before = draftOf(
        await this.invoke(job.projectId, "timeline.get_summary", summary),
      );
      // Pauses and fillers are tightened here, deterministically, as one
      // undoable transaction; Claude gets only what is left (repeated
      // wording and anything the analysis would not cut on its own).
      let tightened: Tightened | null = null;
      let leftover = plan.cuts;
      if (this.tightener && !job.stop) {
        const mechanical = plan.cuts.filter((cut) =>
          cut.kinds.every((kind) => kind === "pause" || kind === "filler"),
        );
        leftover = plan.cuts.filter((cut) => !mechanical.includes(cut));
        const ranges = mapCutsToOutput(mechanical, before.clips);
        if (ranges.length > 0) {
          await this.tightener.applyRanges(job.projectId, before, ranges);
          tightened = {
            pauses: ranges.filter((range) => range.kinds.includes("pause"))
              .length,
            fillers: ranges.filter((range) => range.kinds.includes("filler"))
              .length,
            leftForReview: plan.leftForReview,
          };
        } else
          tightened = {
            pauses: 0,
            fillers: 0,
            leftForReview: plan.leftForReview,
          };
      }
      const clips = tightened
        ? draftOf(
            await this.invoke(job.projectId, "timeline.get_summary", summary),
          ).clips
        : before.clips;
      const evidence: RoughCutEvidence[] = leftover
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
      // The tightening above stands even when the story edit cannot run.
      const block = (await this.editor.blocked?.(job.provider)) ?? null;
      if (block) {
        const kept = await change();
        this.end(
          job,
          kept?.cuts || tightened?.pauses || tightened?.fillers
            ? "completed"
            : "failed",
          magicWandSkipMessage(job.provider, block),
          kept,
          tightened,
        );
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
        roughCutRequest(job.preset, evidence, tightened, job.provider),
        job.provider,
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
          tightened,
        );
      else if (outcome === "stopped")
        this.end(job, "stopped", magicWandIssues.stopped, changed, tightened);
      else if (outcome === "signIn")
        this.end(
          job,
          changed?.cuts || tightened?.pauses || tightened?.fillers
            ? "completed"
            : "failed",
          magicWandSkipMessage(job.provider, "signIn"),
          changed,
          tightened,
        );
      else
        this.end(
          job,
          "failed",
          outcome === "limit" ? magicWandIssues.limit : magicWandIssues.failed,
          changed,
          tightened,
        );
    } catch (error) {
      // A video without usable speech is not an error: there is simply
      // nothing to cut, and the visual edits can go on.
      if (
        error instanceof Error &&
        (error.message === magicWandIssues.noAudio ||
          error.message === magicWandIssues.transcription)
      ) {
        this.end(
          job,
          "completed",
          magicWandIssues.noSpeech,
          await change().catch(() => null),
        );
        return;
      }
      this.end(
        job,
        "failed",
        magicWandIssues.failed,
        await change().catch(() => null),
      );
    } finally {
      this.editor.release?.(job.projectId);
    }
  }
}
