import path from "node:path";
import { sourceAt } from "../../../packages/domain/src/speed.ts";

import type {
  DraftProjectReadResult,
  DraftReadResult,
  PassCheckpointCommitResult,
} from "../../../packages/project-store/src/transactions.ts";
import {
  assertProjectDraftIntegrityView,
  assertProjectDraftView,
  assertProjectFrameRequest,
  assertProjectFrameResult,
  assertProjectView,
  type ProjectDraftView,
  type ProjectDraftIntegrityView,
  type ProjectFrameRequest,
  type ProjectFrameResult,
  type ProjectView,
} from "../../../packages/domain/src/project-view.ts";
import type { MediaFrame } from "../../../packages/domain/src/library.ts";
import { mediaMeasurements } from "../../../packages/media-engine/src/library.ts";

type DraftReader = {
  snapshotWithProject(projectId: string): Promise<DraftProjectReadResult>;
  recordLatestManualStructureCheckpoint(
    projectId: string,
  ): Promise<PassCheckpointCommitResult | null>;
};
type FrameReader = {
  frame(id: string, timeUs: number, signal?: AbortSignal): Promise<MediaFrame>;
};
export type ProjectDraftNotice =
  { ok: true; value: ProjectDraftView } | { ok: false; message: string };

function invalid(): never {
  throw new Error("The committed project could not be read.");
}

function matchesHead(
  current: DraftProjectReadResult,
  request: ProjectFrameRequest,
): boolean {
  return (
    current.draft.project_id === request.projectId &&
    current.draft.base_revision_id === request.baseRevisionId &&
    current.draft.draft_id === request.draftId &&
    current.draft.draft_sequence === request.expectedSequence &&
    current.draft.timeline_sha256 === request.expectedTimelineSha256
  );
}

export function committedDraftView(result: DraftReadResult): ProjectDraftView {
  const { draft } = result;
  const value: ProjectDraftView = {
    projectId: draft.project_id,
    draft: {
      id: draft.draft_id,
      baseRevisionId: draft.base_revision_id,
      sequence: draft.draft_sequence,
      timelineSha256: draft.timeline_sha256,
      undoTransactionId: result.undo_transaction_id,
      redoTransactionId: result.redo_transaction_id,
    },
    timeline: {
      id: draft.timeline.timeline_id,
      durationUs: draft.timeline.duration_us,
      frameRate: structuredClone(draft.timeline.frame_rate),
    },
    clips: draft.timeline.clips.map((clip) => ({
      id: clip.clip_id,
      sourceId: clip.source_id,
      timelineStartUs: clip.timeline_start_us,
      timelineEndUs: clip.timeline_end_us,
      sourceStartUs: clip.source_start_us,
      sourceEndUs: clip.source_end_us,
      ...(clip.speed ? { speed: clip.speed } : {}),
    })),
    transcriptEdits: structuredClone(draft.timeline.transcript_edits ?? []),
    zooms: structuredClone(draft.timeline.zooms ?? []),
    graphics: structuredClone(draft.timeline.graphics ?? []),
  };
  assertProjectDraftView(value);
  return value;
}

export async function invokeWithProjectDraftRefresh<T>(options: {
  toolName: unknown;
  projectId: string;
  activeProjectId: () => string | undefined;
  work: () => Promise<T>;
  drafts: DraftReader;
  notify: (notice: ProjectDraftNotice) => void;
}): Promise<T> {
  const mutation =
    options.toolName === "cut.trim_edge" ||
    options.toolName === "cut.split" ||
    options.toolName === "cut.delete_range" ||
    options.toolName === "cut.delete_ranges" ||
    options.toolName === "cut.restore_range" ||
    options.toolName === "transcript.correct_word" ||
    options.toolName === "transcript.cut_words" ||
    options.toolName === "timeline.split" ||
    options.toolName === "timeline.ripple_delete" ||
    options.toolName === "zoom.set" ||
    options.toolName === "zoom.remove" ||
    options.toolName === "speed.set" ||
    options.toolName === "graphics.set" ||
    options.toolName === "graphics.remove" ||
    options.toolName === "timeline.undo" ||
    options.toolName === "timeline.redo";
  try {
    return await options.work();
  } finally {
    if (mutation && options.activeProjectId() === options.projectId) {
      let notice: ProjectDraftNotice;
      try {
        notice = {
          ok: true,
          value: committedDraftView(
            await options.drafts.snapshotWithProject(options.projectId),
          ),
        };
      } catch {
        notice = {
          ok: false,
          message:
            "The edit may have changed the draft, but the project view could not refresh. Reopen the project.",
        };
      }
      try {
        options.notify(notice);
      } catch {
        // UI delivery cannot replace the editing tool's authoritative result.
      }
    }
  }
}

export class DesktopProjectRuntime {
  private readonly drafts: DraftReader;
  private readonly frames: FrameReader;

  constructor(drafts: DraftReader, frames: FrameReader) {
    this.drafts = drafts;
    this.frames = frames;
  }

  async view(projectId: string): Promise<ProjectView> {
    const current = await this.drafts.snapshotWithProject(projectId),
      snapshot = current.project,
      draft = committedDraftView(current);
    if (
      draft.draft.baseRevisionId !== snapshot.revision.revision_id ||
      draft.timeline.id !== snapshot.timeline.timeline_id
    )
      invalid();
    const sources =
      snapshot.schema_version === "1.1" ? snapshot.sources : [snapshot.source];
    const probes =
      snapshot.schema_version === "1.1"
        ? snapshot.source_probes
        : [snapshot.source_probe];
    const summaries = sources.map((source, index) => ({
      id: source.source_id,
      name: path.basename(source.original_path),
      ...mediaMeasurements(probes[index]!),
      durationUs: source.duration_us,
    }));
    const value: ProjectView = {
      id: snapshot.project.project_id,
      name: snapshot.project.name,
      stage: snapshot.project.workflow_step,
      revisionId: draft.draft.baseRevisionId,
      draft: draft.draft,
      source: summaries[0]!,
      transcriptEdits: draft.transcriptEdits ?? [],
      zooms: draft.zooms ?? [],
      graphics: draft.graphics ?? [],
      ...(snapshot.schema_version === "1.1" ? { sources: summaries } : {}),
      timeline: draft.timeline,
      clips: draft.clips!,
    };
    assertProjectView(value);
    return value;
  }

  async verifyDraftIntegrity(
    projectId: string,
  ): Promise<ProjectDraftIntegrityView> {
    const current = await this.drafts.snapshotWithProject(projectId);
    if (
      current.project.project.project_id !== projectId ||
      current.project.project.workflow_step !== "review"
    )
      invalid();
    const checkpoint =
        await this.drafts.recordLatestManualStructureCheckpoint(projectId),
      latest = await this.drafts.snapshotWithProject(projectId);
    if (
      latest.project.project.project_id !== projectId ||
      latest.project.project.workflow_step !== "review"
    )
      invalid();
    const draft = committedDraftView(latest),
      value: ProjectDraftIntegrityView = {
        draft,
        structuralCheckpointRecorded: Boolean(
          checkpoint &&
          checkpoint.checkpoint.project_id === draft.projectId &&
          checkpoint.checkpoint.draft_id === draft.draft.id &&
          checkpoint.checkpoint.base_revision_id ===
            draft.draft.baseRevisionId &&
          checkpoint.checkpoint.draft_sequence === draft.draft.sequence &&
          checkpoint.checkpoint.timeline_sha256 === draft.draft.timelineSha256,
        ),
      };
    assertProjectDraftIntegrityView(value);
    return value;
  }

  async frame(
    request: ProjectFrameRequest,
    signal?: AbortSignal,
  ): Promise<ProjectFrameResult> {
    assertProjectFrameRequest(request);
    const before = await this.drafts.snapshotWithProject(request.projectId),
      { draft } = before;
    if (!matchesHead(before, request))
      return { status: "stale", draft: committedDraftView(before) };
    if (
      request.timelineTimeUs >= draft.timeline.duration_us ||
      draft.timeline.clips.length < 1 ||
      draft.timeline.clips.length > 4096 ||
      draft.timeline.speed_ids.length !== 0
    )
      invalid();
    const clip = draft.timeline.clips.find(
      (candidate) =>
        request.timelineTimeUs >= candidate.timeline_start_us &&
        request.timelineTimeUs < candidate.timeline_end_us,
    );
    if (
      !clip ||
      !clip.enabled ||
      !before.project.project.source_ids.includes(clip.source_id)
    )
      invalid();
    const sourceTimeUs = sourceAt(clip, request.timelineTimeUs);
    if (
      sourceTimeUs < clip.source_start_us ||
      sourceTimeUs >= clip.source_end_us
    )
      invalid();
    const frame = await this.frames.frame(clip.source_id, sourceTimeUs, signal),
      after = await this.drafts.snapshotWithProject(request.projectId);
    if (!matchesHead(after, request))
      return { status: "stale", draft: committedDraftView(after) };
    const value: ProjectFrameResult = {
      status: "ready",
      projectId: request.projectId,
      draftId: request.draftId,
      baseRevisionId: request.baseRevisionId,
      draftSequence: request.expectedSequence,
      timelineSha256: request.expectedTimelineSha256,
      timelineTimeUs: request.timelineTimeUs,
      frame,
    };
    assertProjectFrameResult(value);
    return value;
  }
}
