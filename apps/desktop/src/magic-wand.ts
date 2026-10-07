import { randomUUID } from "node:crypto";
import {
  mapCutsToOutput,
  planMagicWandCuts,
  type MagicSourceInput,
  type MagicWandPreset,
  type OutputCut,
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
import { CodexVideoEditToolError } from "../../../packages/codex-tools/src/service.ts";

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

interface DraftSummary {
  draft_id: string;
  base_revision_id: string;
  draft_sequence: number;
  timeline_sha256: string;
  clips: {
    source_id: string;
    source_start_us: number;
    source_end_us: number;
    timeline_start_us: number;
    timeline_end_us: number;
  }[];
}

interface Job {
  projectId: string;
  preset: MagicWandPreset;
  stop: boolean;
}

const batchSize = 16;
const presetNames: Record<MagicWandPreset, string> = {
  gentle: "Gentle",
  balanced: "Balanced",
  tight: "Tight",
};

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
 * Main-owned Magic Edit: local transcript evidence in, guarded undoable
 * ripple deletes out. One run per project; Stop takes effect between
 * transactions so every applied batch is a complete, undoable commit.
 */
export class DesktopMagicWand {
  private readonly transcriptions: Transcriptions;
  private readonly invoke: ToolInvoker;
  private readonly views = new Map<string, MagicWandView>();
  private readonly jobs = new Map<string, Job>();
  private readonly pollMs: number;

  constructor(
    transcriptions: Transcriptions,
    invoke: ToolInvoker,
    options: { pollMs?: number } = {},
  ) {
    this.transcriptions = transcriptions;
    this.invoke = invoke;
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
    if (job) job.stop = true;
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
    applied: OutputCut[],
    leftForReview: number,
  ): void {
    const kinds = applied.flatMap((range) => range.kinds);
    this.set(job.projectId, {
      status,
      projectId: job.projectId,
      preset: job.preset,
      progress: null,
      summary:
        status === "failed" && applied.length === 0
          ? null
          : {
              removedUs: applied.reduce(
                (sum, range) => sum + (range.end_us - range.start_us),
                0,
              ),
              cuts: applied.length,
              pauses: kinds.filter((kind) => kind === "pause").length,
              fillers: kinds.filter((kind) => kind === "filler").length,
              repeatedTakes: kinds.filter((kind) => kind === "repeated_take")
                .length,
              leftForReview,
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
    const applied: OutputCut[] = [];
    let leftForReview = 0;
    try {
      const transcription = await this.transcript(job);
      if (!transcription) {
        this.end(job, "stopped", magicWandIssues.stopped, applied, 0);
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
      const plan = planMagicWandCuts(inputs, job.preset);
      leftForReview = plan.leftForReview;
      const summary = { schema_version: "1.0", project_id: job.projectId };
      let draft = draftOf(
        await this.invoke(job.projectId, "timeline.get_summary", summary),
      );
      const ranges = mapCutsToOutput(plan.cuts, draft.clips);
      if (ranges.length === 0) {
        this.end(
          job,
          "completed",
          magicWandIssues.nothing,
          applied,
          leftForReview,
        );
        return;
      }
      this.set(job.projectId, {
        ...this.get(job.projectId),
        status: "applying",
        progress: 0,
      });
      const passGroup = `magic-${randomUUID()}`;
      const kinds = new Set(ranges.flatMap((range) => range.kinds));
      const reason = `Magic Edit (${presetNames[job.preset]}): ${[
        kinds.has("pause") ? "shortened long pauses" : null,
        kinds.has("filler") ? "removed isolated fillers" : null,
        kinds.has("repeated_take") ? "removed an earlier repeated take" : null,
      ]
        .filter(Boolean)
        .join(", ")}.`;
      let expectedSequence = draft.draft_sequence;
      // Latest first: every remaining range is earlier than the ones removed.
      for (let index = 0; index < ranges.length; index += batchSize) {
        if (job.stop) {
          this.end(
            job,
            "stopped",
            magicWandIssues.stopped,
            applied,
            leftForReview,
          );
          return;
        }
        draft = draftOf(
          await this.invoke(job.projectId, "timeline.get_summary", summary),
        );
        if (draft.draft_sequence !== expectedSequence) {
          this.end(
            job,
            "failed",
            magicWandIssues.changed,
            applied,
            leftForReview,
          );
          return;
        }
        const batch = ranges.slice(index, index + batchSize);
        const freshness = {
          schema_version: "1.0",
          request_id: `magic-${randomUUID()}`,
          project_id: job.projectId,
          draft_id: draft.draft_id,
          base_revision_id: draft.base_revision_id,
          expected_sequence: draft.draft_sequence,
          expected_timeline_sha256: draft.timeline_sha256,
          pass_group_id: passGroup,
          reason,
        };
        const result =
          batch.length === 1
            ? await this.invoke(job.projectId, "cut.delete_range", {
                ...freshness,
                start_us: batch[0]!.start_us,
                end_us: batch[0]!.end_us,
              })
            : await this.invoke(job.projectId, "cut.delete_ranges", {
                ...freshness,
                ranges: batch.map((range) => ({
                  start_us: range.start_us,
                  end_us: range.end_us,
                })),
              });
        expectedSequence = draftOf(result).draft_sequence;
        applied.push(...batch);
        this.set(job.projectId, {
          ...this.get(job.projectId),
          progress: Math.min(1, applied.length / ranges.length),
        });
      }
      this.end(job, "completed", null, applied, leftForReview);
    } catch (error) {
      const message =
        error instanceof Error &&
        (error.message === magicWandIssues.noAudio ||
          error.message === magicWandIssues.transcription)
          ? error.message
          : error instanceof CodexVideoEditToolError &&
              (error.code === "stale_draft" || error.code === "edit_conflict")
            ? magicWandIssues.changed
            : magicWandIssues.failed;
      this.end(job, "failed", message, applied, leftForReview);
    }
  }
}
