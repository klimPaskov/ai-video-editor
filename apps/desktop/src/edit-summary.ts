import { randomUUID } from "node:crypto";
import {
  assertEditSummaryView,
  editSummaryGroupPrefix,
  editSummaryUndoneLabel,
  newestKindUndo,
  planEditSummary,
  type EditSummaryKind,
  type EditSummaryView,
} from "../../../packages/domain/src/edit-summary.ts";
import type { DraftTransactionRecord } from "../../../packages/domain/src/draft-transaction.ts";
import type {
  DraftCommitResult,
  DraftReadResult,
} from "../../../packages/project-store/src/transactions.ts";

/** A refusal with a plain message, shown to the person as written. */
export class EditSummaryError extends Error {}

export interface EditSummaryDrafts {
  appliedSnapshot(
    projectId: string,
  ): Promise<DraftReadResult & { applied: DraftTransactionRecord[] }>;
  applyManual(value: unknown): Promise<DraftCommitResult>;
  undoManual(value: unknown): Promise<DraftCommitResult>;
}

const staleDraft = "The edit changed. Try again.";

/**
 * "What Magic Edit did": the rows come from the draft's transaction records;
 * undoing a kind commits ordinary manual transactions, one per item, in one
 * pass group, and putting it back undoes exactly those entries.
 */
export class EditSummary {
  private readonly drafts: EditSummaryDrafts;

  constructor(drafts: EditSummaryDrafts) {
    this.drafts = drafts;
  }

  async view(projectId: string): Promise<EditSummaryView> {
    const current = await this.drafts.appliedSnapshot(projectId);
    const plan = planEditSummary(current.applied, current.draft);
    const undone = newestKindUndo(current.applied);
    const view: EditSummaryView = {
      projectId,
      draftSequence: current.draft.draft_sequence,
      rows: plan.rows,
      putBack: undone
        ? {
            kind: undone.kind,
            label: editSummaryUndoneLabel(undone.kind, undone.entries),
          }
        : null,
    };
    assertEditSummaryView(view);
    return view;
  }

  /** Removes every item of one kind the AI added, as undoable history. */
  async undoKind(
    projectId: string,
    kind: EditSummaryKind,
  ): Promise<DraftReadResult> {
    const first = await this.drafts.appliedSnapshot(projectId);
    const steps = planEditSummary(first.applied, first.draft).steps[kind];
    if (!steps || steps.length === 0)
      throw new EditSummaryError("That change is already gone.");
    const group = `${editSummaryGroupPrefix}${kind}-${randomUUID()}`;
    let latest: DraftReadResult = first;
    for (const step of steps) {
      const head = latest.draft;
      latest = await this.drafts.applyManual({
        schema_version: "1.0",
        request_id: randomUUID(),
        project_id: projectId,
        draft_id: head.draft_id,
        base_revision_id: head.base_revision_id,
        expected_sequence: head.draft_sequence,
        expected_timeline_sha256: head.timeline_sha256,
        pass_group: { pass_group_id: group, kind: passKind(kind) },
        reason: step.reason,
        operations: [step.intent],
      });
    }
    return latest;
  }

  /** Undoes the newest undo of a whole kind, entry by entry. */
  async putBack(projectId: string): Promise<DraftReadResult> {
    const first = await this.drafts.appliedSnapshot(projectId);
    const undone = newestKindUndo(first.applied);
    if (!undone) throw new EditSummaryError(staleDraft);
    let latest: DraftReadResult = first;
    for (let index = 0; index < undone.entries; index++) {
      const head = latest.draft;
      const target = latest.undo_transaction_id;
      if (!target) throw new EditSummaryError(staleDraft);
      latest = await this.drafts.undoManual({
        schema_version: "1.0",
        request_id: randomUUID(),
        project_id: projectId,
        draft_id: head.draft_id,
        base_revision_id: head.base_revision_id,
        expected_sequence: head.draft_sequence,
        expected_timeline_sha256: head.timeline_sha256,
        target_transaction_id: target,
        reason: "Put the change back.",
      });
    }
    return latest;
  }
}

/**
 * The label of the pass group. Undoing a kind is never a "manual" group: that
 * kind is what the structure check records checkpoints for, and a group can
 * hold more transactions than a checkpoint may name.
 */
function passKind(
  kind: EditSummaryKind,
):
  | "spoken_cut"
  | "zoom"
  | "graphics"
  | "captions"
  | "speed"
  | "audio"
  | "layout" {
  switch (kind) {
    case "cuts":
      return "spoken_cut";
    case "zooms":
      return "zoom";
    case "captions":
      return "captions";
    case "speed":
      return "speed";
    case "sound":
    case "music":
    case "effects":
      return "audio";
    case "camera":
      return "layout";
    case "graphics":
    case "transitions":
      return "graphics";
  }
}
