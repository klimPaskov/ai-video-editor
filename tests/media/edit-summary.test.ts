import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  EditSummary,
  EditSummaryError,
} from "../../apps/desktop/src/edit-summary.ts";
import {
  assertEditSummaryUndoRequest,
  assertEditSummaryView,
  editSummaryKinds,
  editSummaryLabel,
  editSummaryUndoneLabel,
  newestKindUndo,
  planEditSummary,
} from "../../packages/domain/src/edit-summary.ts";
import { MediaLibrary } from "../../packages/media-engine/src/library.ts";
import { encodeVerifiedMaster } from "../../packages/media-engine/src/lossless.ts";
import { ProjectStore } from "../../packages/project-store/src/store.ts";
import { DraftTransactionStore } from "../../packages/project-store/src/transactions.ts";

/** A 5 second, 2 fps source with one audio track. */
async function fixture() {
  const base = resolve("test-results/edit-summary");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, "fixture-")),
    source = join(root, "source.mkv"),
    videoPath = join(root, "source.bgra"),
    audioPath = join(root, "source.s16le"),
    video = Buffer.alloc(16 * 16 * 4 * 10);
  for (let frame = 0; frame < 10; frame++)
    for (let pixel = 0; pixel < 16 * 16; pixel++) {
      const offset = (frame * 16 * 16 + pixel) * 4;
      video[offset] = 20 + frame * 30;
      video[offset + 1] = 40 + frame * 20;
      video[offset + 2] = 60 + frame * 10;
      video[offset + 3] = 255;
    }
  await writeFile(videoPath, video);
  await writeFile(audioPath, Buffer.alloc(48_000 * 2 * 5));
  await encodeVerifiedMaster(
    {
      videoPath,
      audioPath,
      role: "canonical",
      format: {
        width: 16,
        height: 16,
        frameRate: { numerator: 2, denominator: 1 },
        pixelFormat: "bgra",
        color: {
          range: "pc",
          space: "gbr",
          primaries: "bt709",
          transfer: "bt709",
        },
        audio: { format: "s16le", sampleRate: 48_000, channelLayout: "mono" },
      },
    },
    source,
  );
  const library = new MediaLibrary(join(root, "library")),
    media = await library.importFile(source),
    projectsRoot = join(root, "projects"),
    projects = new ProjectStore(projectsRoot, library),
    baseline = await projects.createFromMedia(media.id),
    drafts = new DraftTransactionStore(projectsRoot, projects);
  return { baseline, drafts, projectId: baseline.project.project_id };
}

type Drafts = Awaited<ReturnType<typeof fixture>>["drafts"];

let counter = 0;
async function apply(
  drafts: Drafts,
  projectId: string,
  who: "applyClaude" | "applyManual",
  kind: "spoken_cut" | "zoom" | "graphics" | "captions" | "manual" | "speed",
  operations: unknown[],
) {
  const { draft } = await drafts.snapshot(projectId);
  const id = `summary-test-${++counter}`;
  return drafts[who]({
    schema_version: "1.0",
    request_id: id,
    project_id: projectId,
    draft_id: draft.draft_id,
    base_revision_id: draft.base_revision_id,
    expected_sequence: draft.draft_sequence,
    expected_timeline_sha256: draft.timeline_sha256,
    pass_group: { pass_group_id: `pass-${id}`, kind },
    reason: "Summary test.",
    operations,
  });
}

const labelFor = (rows: { kind: string; label: string }[], kind: string) =>
  rows.find((row) => row.kind === kind)?.label;

test("labels are plain one-line rows and every kind has an undone line", () => {
  assert.equal(editSummaryLabel("cuts", 14), "Cut 14 parts");
  assert.equal(editSummaryLabel("cuts", 1), "Cut 1 part");
  assert.equal(editSummaryLabel("zooms", 5), "5 zooms");
  assert.equal(editSummaryLabel("graphics", 1), "1 graphic");
  assert.equal(editSummaryLabel("captions", 1), "Captions on");
  assert.equal(editSummaryLabel("music", 1), "Music added");
  for (const kind of editSummaryKinds) {
    assert.ok(editSummaryLabel(kind, 2).length <= 40, kind);
    assert.ok(editSummaryUndoneLabel(kind, 2).length <= 40, kind);
  }
  assert.equal(editSummaryUndoneLabel("zooms", 5), "5 zooms removed");
  assert.equal(editSummaryUndoneLabel("cuts", 14), "14 parts put back");
});

test("IPC values are exact and bounded", () => {
  assertEditSummaryUndoRequest({
    schema_version: "1.0",
    project_id: "project-1",
    kind: "zooms",
  });
  for (const value of [
    null,
    {},
    { schema_version: "1.0", project_id: "project-1", kind: "everything" },
    { schema_version: "1.0", project_id: "../x", kind: "zooms" },
    {
      schema_version: "1.0",
      project_id: "project-1",
      kind: "zooms",
      path: "/x",
    },
  ])
    assert.throws(() => assertEditSummaryUndoRequest(value));
  assertEditSummaryView({
    projectId: "project-1",
    draftSequence: 3,
    rows: [{ kind: "zooms", label: "5 zooms", count: 5 }],
    putBack: { kind: "cuts", label: "2 parts put back" },
  });
  for (const value of [
    {
      projectId: "project-1",
      draftSequence: 3,
      rows: [{ kind: "zooms", label: "five zooms", count: 5 }],
      putBack: null,
    },
    {
      projectId: "project-1",
      draftSequence: 3,
      rows: [
        { kind: "zooms", label: "1 zoom", count: 1 },
        { kind: "zooms", label: "1 zoom", count: 1 },
      ],
      putBack: null,
    },
    { projectId: "project-1", draftSequence: -1, rows: [], putBack: null },
  ])
    assert.throws(() => assertEditSummaryView(value));
});

test("only what an AI connection did is listed, and only what is still there", async () => {
  const { drafts, projectId } = await fixture();
  const first = await drafts.snapshot(projectId);
  const sourceId = first.draft.timeline.clips[0]!.source_id;
  const zoom = (id: string, start: number, end: number) => ({
    zoom_id: id,
    source_id: sourceId,
    source_start_us: start,
    source_end_us: end,
    center_x: 0.5,
    center_y: 0.5,
    scale: 2,
  });
  // The AI cuts two pauses (as one transaction) and adds two zooms and captions.
  await apply(drafts, projectId, "applyClaude", "spoken_cut", [
    { type: "ripple_delete", start_us: 3_200_000, end_us: 3_700_000 },
    { type: "ripple_delete", start_us: 1_500_000, end_us: 2_000_000 },
  ]);
  await apply(drafts, projectId, "applyClaude", "zoom", [
    { type: "set_zoom", zoom: zoom("zoom-ai-1", 0, 700_000) },
  ]);
  await apply(drafts, projectId, "applyClaude", "zoom", [
    { type: "set_zoom", zoom: zoom("zoom-ai-2", 2_000_000, 2_700_000) },
  ]);
  await apply(drafts, projectId, "applyClaude", "captions", [
    {
      type: "set_captions",
      captions: {
        enabled: true,
        style: "plain",
        size: "medium",
        position: "bottom",
        burnIn: false,
      },
    },
  ]);
  // A manual zoom is the user's own and is never listed.
  await apply(drafts, projectId, "applyManual", "zoom", [
    { type: "set_zoom", zoom: zoom("zoom-manual-1", 4_000_000, 4_700_000) },
  ]);
  const current = await drafts.appliedSnapshot(projectId);
  const plan = planEditSummary(current.applied, current.draft);
  assert.equal(labelFor(plan.rows, "cuts"), "Cut 2 parts");
  assert.equal(labelFor(plan.rows, "zooms"), "2 zooms");
  assert.equal(labelFor(plan.rows, "captions"), "Captions on");
  assert.equal(plan.rows.length, 3);
  assert.equal(plan.steps.zooms?.length, 2);
  assert.equal(newestKindUndo(current.applied), null);
});

test("undoing a kind is ordinary undoable history and Put back reverses exactly it", async () => {
  const { drafts, projectId } = await fixture();
  const summary = new EditSummary(drafts);
  const first = await drafts.snapshot(projectId);
  const sourceId = first.draft.timeline.clips[0]!.source_id;
  const durationBefore = first.draft.timeline.duration_us;
  await apply(drafts, projectId, "applyClaude", "spoken_cut", [
    { type: "ripple_delete", start_us: 3_200_000, end_us: 3_700_000 },
    { type: "ripple_delete", start_us: 1_500_000, end_us: 2_000_000 },
  ]);
  for (const [id, start, end] of [
    ["zoom-ai-1", 0, 700_000],
    ["zoom-ai-2", 2_000_000, 2_700_000],
  ] as const)
    await apply(drafts, projectId, "applyClaude", "zoom", [
      {
        type: "set_zoom",
        zoom: {
          zoom_id: id,
          source_id: sourceId,
          source_start_us: start,
          source_end_us: end,
          center_x: 0.5,
          center_y: 0.5,
          scale: 2,
        },
      },
    ]);
  const beforeView = await summary.view(projectId);
  assert.deepEqual(
    beforeView.rows.map((row) => row.label),
    ["Cut 2 parts", "2 zooms"],
  );
  assert.equal(beforeView.putBack, null);
  const cutDraft = await drafts.snapshot(projectId);
  assert.equal(cutDraft.draft.timeline.duration_us, durationBefore - 1_000_000);

  // Undo the zooms: two ordinary transactions in one group, shared Undo works.
  const afterZoomUndo = await summary.undoKind(projectId, "zooms");
  assert.deepEqual(afterZoomUndo.draft.timeline.zooms ?? [], []);
  const view = await summary.view(projectId);
  assert.deepEqual(
    view.rows.map((row) => row.label),
    ["Cut 2 parts"],
  );
  assert.deepEqual(view.putBack, {
    kind: "zooms",
    label: "2 zooms removed",
  });
  const afterOne = await drafts.undoManual({
    schema_version: "1.0",
    request_id: "summary-test-shared-undo",
    project_id: projectId,
    draft_id: afterZoomUndo.draft.draft_id,
    base_revision_id: afterZoomUndo.draft.base_revision_id,
    expected_sequence: afterZoomUndo.draft.draft_sequence,
    expected_timeline_sha256: afterZoomUndo.draft.timeline_sha256,
    target_transaction_id: afterZoomUndo.undo_transaction_id!,
    reason: "Shared Undo.",
  });
  assert.equal(afterOne.draft.timeline.zooms?.length, 1);
  // One entry of the group is gone, so Put back covers the one that is left.
  assert.deepEqual((await summary.view(projectId)).putBack, {
    kind: "zooms",
    label: "1 zoom removed",
  });
  const putBack = await summary.putBack(projectId);
  assert.equal(putBack.draft.timeline.zooms?.length, 2);
  assert.equal((await summary.view(projectId)).putBack, null);

  // Cuts: restoring the removed source parts brings the length back.
  const restored = await summary.undoKind(projectId, "cuts");
  assert.equal(restored.draft.timeline.duration_us, durationBefore);
  assert.deepEqual(
    (await summary.view(projectId)).rows.map((row) => row.label),
    ["2 zooms"],
  );
  const backAgain = await summary.putBack(projectId);
  assert.equal(
    backAgain.draft.timeline.duration_us,
    durationBefore - 1_000_000,
  );
  assert.deepEqual(
    (await summary.view(projectId)).rows.map((row) => row.label),
    ["Cut 2 parts", "2 zooms"],
  );
});

test("a kind with nothing left says so, and Put back needs the undo to be the newest change", async () => {
  const { drafts, projectId } = await fixture();
  const summary = new EditSummary(drafts);
  await assert.rejects(summary.undoKind(projectId, "zooms"), EditSummaryError);
  await assert.rejects(summary.putBack(projectId), EditSummaryError);
  const first = await drafts.snapshot(projectId);
  await apply(drafts, projectId, "applyClaude", "zoom", [
    {
      type: "set_zoom",
      zoom: {
        zoom_id: "zoom-ai-1",
        source_id: first.draft.timeline.clips[0]!.source_id,
        source_start_us: 0,
        source_end_us: 700_000,
        center_x: 0.5,
        center_y: 0.5,
        scale: 2,
      },
    },
  ]);
  await summary.undoKind(projectId, "zooms");
  assert.notEqual((await summary.view(projectId)).putBack, null);
  // A later manual edit ends the chance to put it back this way.
  await apply(drafts, projectId, "applyManual", "manual", [
    { type: "ripple_delete", start_us: 0, end_us: 500_000 },
  ]);
  assert.equal((await summary.view(projectId)).putBack, null);
  await assert.rejects(summary.putBack(projectId), EditSummaryError);
});
