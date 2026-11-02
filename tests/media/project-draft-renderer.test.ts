import assert from "node:assert/strict";
import test from "node:test";

import { reconcileProjectDraft } from "../../apps/desktop/renderer/project-draft.ts";
import type {
  ProjectDraftView,
  ProjectView,
} from "../../packages/domain/src/project-view.ts";

function project(): ProjectView {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Fixture",
    stage: "edit",
    revisionId: "22222222-2222-4222-8222-222222222222",
    draft: {
      id: "draft-22222222-2222-4222-8222-222222222222",
      baseRevisionId: "22222222-2222-4222-8222-222222222222",
      sequence: 2,
      timelineSha256: "a".repeat(64),
      undoTransactionId: "transaction-002",
      redoTransactionId: null,
    },
    source: {
      id: "33333333-3333-4333-8333-333333333333",
      name: "Fixture.mkv",
      width: 16,
      height: 16,
      durationUs: 1_500_000,
      frameRate: 2,
      previewAvailable: true,
    },
    timeline: {
      id: "44444444-4444-4444-8444-444444444444",
      durationUs: 1_000_000,
      frameRate: { numerator: 2, denominator: 1 },
    },
  };
}

function changed(sequence: number, hash = "b".repeat(64)): ProjectDraftView {
  const current = project();
  return {
    projectId: current.id,
    draft: {
      ...current.draft,
      sequence,
      timelineSha256: hash,
      undoTransactionId: "transaction-003",
      redoTransactionId: null,
    },
    timeline: { ...current.timeline, durationUs: 500_000 },
  };
}

test("renderer reconciliation applies only a newer matching committed head", () => {
  const current = project(),
    result = reconcileProjectDraft(current, changed(3));
  assert.equal(result.status, "applied");
  if (result.status !== "applied") throw new Error("Expected update");
  assert.equal(result.value.stage, "edit");
  assert.equal(result.value.source, current.source);
  assert.equal(result.value.timeline.durationUs, 500_000);
  assert.equal(result.value.draft.sequence, 3);
  assert.equal(current.timeline.durationUs, 1_000_000);
});

test("renderer reconciliation ignores duplicates and old events but rejects divergent heads", () => {
  const current = project();
  assert.deepEqual(reconcileProjectDraft(current, changed(1)), {
    status: "stale",
  });
  assert.deepEqual(
    reconcileProjectDraft(current, changed(2, current.draft.timelineSha256)),
    { status: "unchanged" },
  );
  assert.deepEqual(reconcileProjectDraft(current, changed(2)), {
    status: "invalid",
  });
  assert.deepEqual(
    reconcileProjectDraft(current, {
      ...changed(3),
      projectId: current.source.id,
    }),
    { status: "unrelated" },
  );
  const newHead = changed(3);
  assert.deepEqual(
    reconcileProjectDraft(current, {
      ...newHead,
      draft: { ...newHead.draft, id: "another-draft" },
    }),
    { status: "invalid" },
  );
});

test("a committed trim replaces the clip map used by manual controls", () => {
  const current = project();
  current.clips = [
    {
      id: "clip-main",
      sourceId: current.source.id,
      timelineStartUs: 0,
      timelineEndUs: 1_000_000,
      sourceStartUs: 0,
      sourceEndUs: 1_000_000,
    },
  ];
  const update = changed(3);
  update.clips = [
    {
      id: "clip-main",
      sourceId: current.source.id,
      timelineStartUs: 0,
      timelineEndUs: 500_000,
      sourceStartUs: 500_000,
      sourceEndUs: 1_000_000,
    },
  ];
  const result = reconcileProjectDraft(current, update);
  assert.equal(result.status, "applied");
  if (result.status !== "applied") return;
  assert.deepEqual(result.value.clips, update.clips);
  assert.equal(current.clips[0]?.sourceStartUs, 0);
  const missingMap = reconcileProjectDraft(current, changed(4));
  assert.equal(missingMap.status, "applied");
  if (missingMap.status === "applied")
    assert.equal(missingMap.value.clips, undefined);
});

test("renderer reconciliation retains every split fragment and its ordered mapping", () => {
  const current = project();
  current.clips = [
    {
      id: "clip-main",
      sourceId: current.source.id,
      timelineStartUs: 0,
      timelineEndUs: 1_000_000,
      sourceStartUs: 0,
      sourceEndUs: 1_000_000,
    },
  ];
  const update = changed(3);
  update.timeline.durationUs = 1_000_000;
  update.clips = [
    { ...current.clips[0]!, timelineEndUs: 250_000, sourceEndUs: 250_000 },
    {
      ...current.clips[0]!,
      id: "clip-right-1",
      timelineStartUs: 250_000,
      timelineEndUs: 500_000,
      sourceStartUs: 250_000,
      sourceEndUs: 500_000,
    },
    {
      ...current.clips[0]!,
      id: "clip-right-2",
      timelineStartUs: 500_000,
      timelineEndUs: 1_000_000,
      sourceStartUs: 500_000,
      sourceEndUs: 1_000_000,
    },
  ];
  const result = reconcileProjectDraft(current, update);
  assert.equal(result.status, "applied");
  if (result.status !== "applied") return;
  assert.deepEqual(result.value.clips, update.clips);
  assert.equal(result.value.clips?.[2]?.id, "clip-right-2");
  assert.equal(current.clips.length, 1);
});
