import type {
  ProjectDraftView,
  ProjectView,
} from "../../../packages/domain/src/project-view.ts";

export type ProjectDraftReconciliation =
  | { status: "applied"; value: ProjectView }
  | { status: "unchanged" | "stale" | "unrelated" | "invalid" };

/** Merge only monotonic draft authority; navigation and panel state stay renderer-owned. */
export function reconcileProjectDraft(
  current: ProjectView,
  changed: ProjectDraftView,
): ProjectDraftReconciliation {
  if (changed.projectId !== current.id) return { status: "unrelated" };
  if (
    changed.draft.baseRevisionId !== current.revisionId ||
    changed.timeline.id !== current.timeline.id ||
    changed.draft.id !== current.draft.id
  )
    return { status: "invalid" };
  if (changed.draft.sequence < current.draft.sequence)
    return { status: "stale" };
  if (changed.draft.sequence === current.draft.sequence)
    return changed.draft.timelineSha256 === current.draft.timelineSha256
      ? { status: "unchanged" }
      : { status: "invalid" };
  const next = { ...current };
  delete next.clips;
  delete next.zooms;
  delete next.graphics;
  return {
    status: "applied",
    value: {
      ...next,
      draft: changed.draft,
      timeline: changed.timeline,
      ...(changed.transcriptEdits
        ? { transcriptEdits: changed.transcriptEdits }
        : {}),
      ...(changed.zooms ? { zooms: changed.zooms } : {}),
      ...(changed.graphics ? { graphics: changed.graphics } : {}),
      ...(changed.clips ? { clips: changed.clips } : {}),
    },
  };
}
