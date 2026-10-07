import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  assertProjectDraftIntegrityView,
  assertProjectList,
  assertProjectDraftView,
  assertProjectFrameRequest,
  assertProjectFrameResult,
  assertManualTrimRequest,
  assertManualSplitRequest,
  assertManualRangeCutRequest,
  assertManualZoomRequest,
  assertManualZoomRemoveRequest,
  assertManualSpeedRequest,
  assertManualRestoreRangeRequest,
  assertManualTranscriptCorrectionRequest,
  assertManualUndoRequest,
  assertManualRedoRequest,
  assertProjectNavigation,
  assertProjectRequest,
  assertTwoSourceProjectRequest,
  assertProjectView,
  projectStages,
} from "../../packages/domain/src/project-view.ts";
import type { ProjectView } from "../../packages/domain/src/project-view.ts";

function view(): ProjectView {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Synthetic project",
    stage: "record_import",
    revisionId: "22222222-2222-4222-8222-222222222222",
    draft: {
      id: "draft-22222222-2222-4222-8222-222222222222",
      baseRevisionId: "22222222-2222-4222-8222-222222222222",
      sequence: 0,
      timelineSha256: "a".repeat(64),
      undoTransactionId: null,
      redoTransactionId: null,
    },
    source: {
      id: "33333333-3333-4333-8333-333333333333",
      name: "Fixture.mkv",
      width: 1920,
      height: 1080,
      durationUs: 1001000,
      frameRate: 30000 / 1001,
      previewAvailable: true,
    },
    timeline: {
      id: "44444444-4444-4444-8444-444444444444",
      durationUs: 1001000,
      frameRate: { numerator: 30000, denominator: 1001 },
    },
  };
}
test("project IPC runtime accepts path-free views and exact requests for all five navigation stages", () => {
  const value = view();
  assertProjectRequest({ id: value.id });
  assertProjectRequest({ id: value.source.id });
  assertProjectList([]);
  for (const stage of projectStages) {
    value.stage = stage;
    assertProjectNavigation({ id: value.id, stage });
    assertProjectView(value);
    assertProjectList([value]);
  }
});

test("draft integrity IPC accepts only a path-free committed head and checkpoint flag", () => {
  const project = view(),
    draft = {
      projectId: project.id,
      draft: project.draft,
      timeline: project.timeline,
    };
  assertProjectDraftIntegrityView({
    draft,
    structuralCheckpointRecorded: true,
  });
  assert.throws(() =>
    assertProjectDraftIntegrityView({
      draft,
      structuralCheckpointRecorded: "recorded",
    }),
  );
  assert.throws(() =>
    assertProjectDraftIntegrityView({
      draft: { ...draft, sourcePath: "C:/private/source.mkv" },
      structuralCheckpointRecorded: false,
    }),
  );
});
test("project requests reject paths, malformed IDs, unknown stages and excess fields", () => {
  for (const value of [
    null,
    [],
    {},
    { id: "../private" },
    { id: 1 },
    { id: "11111111-1111-1111-1111-111111111111" },
    { id: view().id, path: "/private" },
  ]) {
    assert.throws(() => assertProjectRequest(value));
  }
  for (const value of [
    null,
    {},
    { id: view().id },
    { id: view().id, stage: "complete" },
    { id: view().id, stage: "qa" },
    { id: view().id, stage: "edit", path: "/private" },
    { id: "../private", stage: "edit" },
  ]) {
    assert.throws(() => assertProjectNavigation(value));
  }
});
test("two-source project requests require two distinct path-free library IDs", () => {
  const firstId = view().source.id;
  const secondId = "55555555-5555-4555-8555-555555555555";
  assertTwoSourceProjectRequest({ firstId, secondId });
  for (const bad of [
    null,
    {},
    { firstId },
    { firstId, secondId: firstId },
    { firstId: "../private", secondId },
    { firstId, secondId: "C:\\private\\video.mp4" },
    { firstId, secondId, path: "/private/source.mp4" },
  ])
    assert.throws(() => assertTwoSourceProjectRequest(bad));
});
test("project views accept exactly two ordered summaries and preserve legacy view shape", () => {
  const legacy = view();
  assertProjectView(legacy);
  assert.equal(Object.keys(legacy).length, 7);
  const second = {
    ...legacy.source,
    id: "55555555-5555-4555-8555-555555555555",
    name: "Second.mkv",
  };
  const joined: ProjectView = {
    ...legacy,
    sources: [{ ...legacy.source }, second],
  };
  assertProjectView(joined);
  for (const sources of [
    [],
    [legacy.source],
    [legacy.source, second, second],
    [second, legacy.source],
    [legacy.source, { ...legacy.source }],
    [{ ...legacy.source, name: "Changed.mkv" }, second],
    [legacy.source, { ...second, path: "/private/video.mp4" }],
    [legacy.source, { ...second, id: legacy.id }],
  ])
    assert.throws(() => assertProjectView({ ...joined, sources }));
  assert.throws(() => assertProjectView({ ...joined, path: "/private" }));
});
test("project frame exchanges bind decoded pixels to one committed draft head", () => {
  const project = view();
  const request = {
    projectId: project.id,
    draftId: project.draft.id,
    baseRevisionId: project.revisionId,
    expectedSequence: project.draft.sequence,
    expectedTimelineSha256: project.draft.timelineSha256,
    timelineTimeUs: 0,
  };
  assertProjectFrameRequest(request);
  assertProjectFrameResult({
    status: "ready",
    projectId: project.id,
    draftId: project.draft.id,
    baseRevisionId: project.revisionId,
    draftSequence: project.draft.sequence,
    timelineSha256: project.draft.timelineSha256,
    timelineTimeUs: 0,
    frame: { width: 1, height: 1, rgbaBase64: "AAAAAA==" },
  });
  assertProjectFrameResult({
    status: "stale",
    draft: {
      projectId: project.id,
      draft: project.draft,
      timeline: project.timeline,
    },
  });
  for (const extra of [
    { ...request, path: "/private/source" },
    { ...request, expectedSequence: -1 },
    { ...request, expectedTimelineSha256: "bad" },
    { ...request, timelineTimeUs: 0.5 },
  ])
    assert.throws(() => assertProjectFrameRequest(extra));
});
test("manual edit IPC accepts only exact intent and a valid draft head", () => {
  const project = view();
  const head = {
    schema_version: "1.0",
    projectId: project.id,
    draftId: project.draft.id,
    baseRevisionId: project.revisionId,
    expectedSequence: 0,
    expectedTimelineSha256: project.draft.timelineSha256,
  };
  const trim = {
    ...head,
    clipId: "clip-main",
    edge: "start",
    timelinePositionUs: 500_000,
  };
  const undo = { ...head, targetTransactionId: "transaction-1" };
  const redo = { ...head, targetTransactionId: "undo-transaction-1" };
  const split = {
    ...head,
    clipId: "clip-main",
    timelinePositionUs: 500_000,
  };
  const rangeCut = { ...head, startUs: 0, endUs: 500_000 };
  const rangeRestore = {
    ...head,
    sourceId: project.source.id,
    sourceStartUs: 500_000,
    sourceEndUs: 1_000_000,
  };
  assertManualTrimRequest(trim);
  assertManualSplitRequest(split);
  assertManualRangeCutRequest(rangeCut);
  assertManualRestoreRangeRequest(rangeRestore);
  assertManualUndoRequest(undo);
  assertManualRedoRequest(redo);
  for (const bad of [
    { ...trim, path: "/private/source.mp4" },
    { ...trim, schema_version: "2.0" },
    { ...trim, clipId: "../private" },
    { ...trim, edge: "middle" },
    { ...trim, timelinePositionUs: 0 },
    { ...trim, timelinePositionUs: 0.5 },
    { ...trim, expectedTimelineSha256: "bad" },
    { ...trim, projectId: project.revisionId },
  ])
    assert.throws(() => assertManualTrimRequest(bad));
  for (const bad of [
    { ...split, path: "/private/source.mp4" },
    { ...split, schema_version: "2.0" },
    { ...split, clipId: "../private" },
    { ...split, timelinePositionUs: 0 },
    { ...split, timelinePositionUs: 0.5 },
    { ...split, edge: "start" },
    { ...split, expectedTimelineSha256: "bad" },
  ])
    assert.throws(() => assertManualSplitRequest(bad));
  for (const bad of [
    { ...rangeCut, path: "/private/source.mp4" },
    { ...rangeCut, schema_version: "2.0" },
    { ...rangeCut, startUs: -1 },
    { ...rangeCut, startUs: 500_000, endUs: 500_000 },
    { ...rangeCut, startUs: 500_001, endUs: 500_000 },
    { ...rangeCut, startUs: 0.5 },
    { ...rangeCut, endUs: Number.MAX_SAFE_INTEGER + 1 },
    { ...rangeCut, expectedTimelineSha256: "bad" },
    { ...rangeCut, request_id: "renderer-owned" },
  ])
    assert.throws(() => assertManualRangeCutRequest(bad));
  for (const bad of [
    { ...rangeRestore, path: "/private/source.mp4" },
    { ...rangeRestore, sourceId: "../private" },
    { ...rangeRestore, sourceStartUs: -1 },
    { ...rangeRestore, sourceEndUs: rangeRestore.sourceStartUs },
    { ...rangeRestore, sourceStartUs: 0.5 },
    { ...rangeRestore, expectedTimelineSha256: "bad" },
  ])
    assert.throws(() => assertManualRestoreRangeRequest(bad));
  for (const bad of [
    { ...undo, targetTransactionId: "" },
    { ...undo, expectedSequence: -1 },
    { ...undo, request_id: "renderer-owned" },
  ])
    assert.throws(() => assertManualUndoRequest(bad));
  for (const bad of [
    { ...redo, targetTransactionId: "" },
    { ...redo, expectedSequence: -1 },
    { ...redo, request_id: "renderer-owned" },
    { ...redo, path: "/private/project" },
  ])
    assert.throws(() => assertManualRedoRequest(bad));
});

test("transcript corrections are path-free, draft-bound, and tied to a source word", () => {
  const project = view();
  const head = {
    schema_version: "1.0",
    projectId: project.id,
    draftId: project.draft.id,
    baseRevisionId: project.revisionId,
    expectedSequence: project.draft.sequence,
    expectedTimelineSha256: project.draft.timelineSha256,
    sourceId: project.source.id,
    transcriptId: "transcript-local-001",
    wordId: "word-local-000001",
    expectedText: "teh",
    replacementText: "the",
  };
  assertManualTranscriptCorrectionRequest(head);
  for (const bad of [
    { ...head, sourcePath: "C:/private/source.mkv" },
    { ...head, transcriptId: "../private" },
    { ...head, replacementText: "" },
    { ...head, expectedText: head.replacementText },
    { ...head, expectedSequence: -1 },
  ])
    assert.throws(() => assertManualTranscriptCorrectionRequest(bad));

  const correction = {
    source_id: project.source.id,
    transcript_id: head.transcriptId,
    word_id: head.wordId,
    original_text: "teh",
    replacement_text: "the",
  };
  assertProjectView({ ...project, transcriptEdits: [correction] });
  assert.throws(() =>
    assertProjectView({
      ...project,
      transcriptEdits: [
        { ...correction, source_id: "55555555-5555-4555-8555-555555555555" },
      ],
    }),
  );
});
test("committed fragments retain ordered source intervals and reject overlap or source revisits", () => {
  const base = view();
  const second = {
    ...base.source,
    id: "55555555-5555-4555-8555-555555555555",
    name: "Second.mkv",
  };
  const clips = [
    {
      id: "clip-left",
      sourceId: base.source.id,
      timelineStartUs: 0,
      timelineEndUs: 400_000,
      sourceStartUs: 0,
      sourceEndUs: 400_000,
    },
    {
      id: "clip-right",
      sourceId: base.source.id,
      timelineStartUs: 400_000,
      timelineEndUs: 800_000,
      sourceStartUs: 500_000,
      sourceEndUs: 900_000,
    },
    {
      id: "clip-second",
      sourceId: second.id,
      timelineStartUs: 800_000,
      timelineEndUs: 1_300_000,
      sourceStartUs: 0,
      sourceEndUs: 500_000,
    },
  ];
  const project: ProjectView = {
    ...base,
    sources: [base.source, second],
    clips,
    timeline: { ...base.timeline, durationUs: 1_300_000 },
  };
  assertProjectView(project);
  assertProjectDraftView({
    projectId: project.id,
    draft: project.draft,
    timeline: project.timeline,
    clips,
  });
  for (const bad of [
    [clips[0], { ...clips[1], id: clips[0]!.id }, clips[2]],
    [
      clips[0],
      { ...clips[1], sourceStartUs: 399_999, sourceEndUs: 799_999 },
      clips[2],
    ],
    [
      clips[0],
      { ...clips[2], timelineStartUs: 400_000, timelineEndUs: 900_000 },
      { ...clips[1], timelineStartUs: 900_000, timelineEndUs: 1_300_000 },
    ],
    [clips[0], { ...clips[1], timelineStartUs: 400_001 }, clips[2]],
    [
      clips[0],
      { ...clips[1], sourceEndUs: base.source.durationUs + 1 },
      clips[2],
    ],
  ])
    assert.throws(() => assertProjectView({ ...project, clips: bad }));
  const many = Array.from({ length: 4097 }, (_, index) => ({
    id: `clip-${index}`,
    sourceId: base.source.id,
    timelineStartUs: index,
    timelineEndUs: index + 1,
    sourceStartUs: index,
    sourceEndUs: index + 1,
  }));
  assertProjectView({
    ...base,
    timeline: { ...base.timeline, durationUs: 4096 },
    clips: many.slice(0, 4096),
  });
  assert.throws(() =>
    assertProjectDraftView({
      projectId: base.id,
      draft: base.draft,
      timeline: { ...base.timeline, durationUs: many.length },
      clips: many,
    }),
  );
});
test("committed clip maps enforce contiguous ordered half-open source mapping", () => {
  const first = view();
  const firstClip = {
    id: "clip-main",
    sourceId: first.source.id,
    timelineStartUs: 0,
    timelineEndUs: first.timeline.durationUs,
    sourceStartUs: 0,
    sourceEndUs: first.timeline.durationUs,
  };
  assertProjectView({ ...first, clips: [firstClip] });
  const secondSource = {
    ...first.source,
    id: "55555555-5555-4555-8555-555555555555",
    name: "Second.mkv",
  };
  const secondClip = {
    ...firstClip,
    id: "clip-following",
    sourceId: secondSource.id,
    timelineStartUs: firstClip.timelineEndUs,
    timelineEndUs: firstClip.timelineEndUs * 2,
  };
  const joined: ProjectView = {
    ...first,
    sources: [first.source, secondSource],
    clips: [firstClip, secondClip],
    timeline: { ...first.timeline, durationUs: firstClip.timelineEndUs * 2 },
  };
  assertProjectView(joined);
  assertProjectView({
    ...joined,
    clips: [firstClip],
    timeline: { ...joined.timeline, durationUs: firstClip.timelineEndUs },
  });
  assertProjectView({
    ...joined,
    clips: [
      {
        ...secondClip,
        timelineStartUs: 0,
        timelineEndUs: secondClip.sourceEndUs - secondClip.sourceStartUs,
      },
    ],
    timeline: {
      ...joined.timeline,
      durationUs: secondClip.sourceEndUs - secondClip.sourceStartUs,
    },
  });
  const draftOnly = {
    projectId: joined.id,
    draft: joined.draft,
    timeline: joined.timeline,
    clips: joined.clips,
  };
  assertProjectDraftView(draftOnly);
  for (const clips of [
    [],
    [secondClip, firstClip],
    [
      firstClip,
      { ...secondClip, timelineStartUs: secondClip.timelineStartUs + 1 },
    ],
    [firstClip, { ...secondClip, sourceEndUs: secondClip.sourceEndUs + 1 }],
    [firstClip, { ...secondClip, sourceId: firstClip.sourceId }],
    [firstClip, { ...secondClip, sourceEndUs: secondSource.durationUs + 1 }],
    [firstClip, { ...secondClip, path: "/private" }],
  ])
    assert.throws(() => assertProjectView({ ...joined, clips }));
  assert.throws(() =>
    assertProjectView({
      ...joined,
      clips: [firstClip],
      timeline: { ...joined.timeline, durationUs: firstClip.timelineEndUs + 1 },
    }),
  );
  assert.throws(() =>
    assertProjectDraftView({
      ...draftOnly,
      clips: [
        firstClip,
        { ...secondClip, timelineEndUs: secondClip.timelineEndUs + 1 },
      ],
    }),
  );
});
test("project views reject unsafe numeric formats, private fields and malformed shapes", () => {
  for (const bad of [
    NaN,
    Infinity,
    -Infinity,
    0,
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
    "30000",
    true,
    null,
  ]) {
    for (const key of ["numerator", "denominator"]) {
      const value = view();
      Object.assign(value.timeline.frameRate, { [key]: bad });
      assert.throws(() => assertProjectView(value));
    }
    const value = view();
    Object.assign(value.timeline, { durationUs: bad });
    assert.throws(() => assertProjectView(value));
  }
  for (const name of [
    "",
    "x".repeat(161),
    "/private/video",
    "C:\\private\\video",
    "bad\u0000name",
  ]) {
    const value = view();
    value.name = name;
    assert.throws(() => assertProjectView(value));
  }
  for (const location of ["root", "source", "timeline", "frameRate"]) {
    const value = view();
    const target =
      location === "root"
        ? value
        : location === "source"
          ? value.source
          : location === "timeline"
            ? value.timeline
            : value.timeline.frameRate;
    Object.assign(target, { path: "/private/project.json" });
    assert.throws(() => assertProjectView(value));
  }
  for (const value of [
    null,
    [],
    {},
    { ...view(), stage: "complete" },
    { ...view(), source: null },
    { ...view(), timeline: { ...view().timeline, frameRate: 29.97 } },
  ]) {
    assert.throws(() => assertProjectView(value));
  }
});
test("runtime rejects shared role identities and duplicate project IDs even if views differ", () => {
  for (const role of ["revision", "draft", "source", "timeline"]) {
    const value = view();
    if (role === "revision") value.revisionId = value.id;
    else if (role === "draft") value.draft.id = value.id;
    else if (role === "source") value.source.id = value.id;
    else value.timeline.id = value.id;
    assert.throws(() => assertProjectView(value));
  }
  const first = view(),
    second = view();
  second.name = "Different display name";
  assert.throws(() => assertProjectList([first, second]));
  assert.throws(() => assertProjectList(Array.from({ length: 1001 }, view)));
  for (const value of [null, {}, [null]])
    assert.throws(() => assertProjectList(value));
  const staleBase = view();
  staleBase.draft.baseRevisionId = staleBase.source.id;
  assert.throws(() => assertProjectView(staleBase));
  assert.throws(() =>
    assertProjectDraftView({
      projectId: view().id,
      draft: { ...view().draft, sequence: 0.5 },
      timeline: view().timeline,
    }),
  );
});

test("zoom requests are path-free, bounded and tied to a draft head", () => {
  const example = (name: string) =>
    JSON.parse(
      readFileSync(
        new URL(`../../docs/examples/${name}.example.json`, import.meta.url),
        "utf8",
      ),
    ) as { payload: Record<string, unknown>; response: { value: unknown } };
  const set = example("desktop_ipc_manual_zoom");
  const remove = example("desktop_ipc_manual_zoom_remove");
  assertManualZoomRequest(set.payload);
  assertManualZoomRequest({ ...set.payload, zoomId: "zoom-existing" });
  assertManualZoomRemoveRequest(remove.payload);
  assertProjectDraftView(set.response.value);
  assertProjectDraftView(remove.response.value);
  for (const bad of [
    { ...set.payload, path: "/private/source.mp4" },
    { ...set.payload, zoomId: "../private" },
    { ...set.payload, endUs: 500_000 },
    { ...set.payload, centerX: 1.5 },
    { ...set.payload, centerY: -0.1 },
    { ...set.payload, scale: 1 },
    { ...set.payload, scale: 8 },
    { ...set.payload, scale: Number.NaN },
    { ...set.payload, expectedTimelineSha256: "bad" },
  ])
    assert.throws(() => assertManualZoomRequest(bad));
  for (const bad of [
    { ...remove.payload, zoomId: null },
    { ...remove.payload, zoomId: "../private" },
    { ...remove.payload, extra: true },
  ])
    assert.throws(() => assertManualZoomRemoveRequest(bad));
  const value = set.response.value as unknown as {
    zooms: Record<string, unknown>[];
  };
  for (const zooms of [
    [{ ...value.zooms[0], scale: 9 }],
    [{ ...value.zooms[0], source_start_us: 900_000 }],
    [value.zooms[0], value.zooms[0]],
  ])
    assert.throws(() => assertProjectDraftView({ ...value, zooms }));
});

test("speed requests and sped-up clip views are exact", () => {
  const example = JSON.parse(
    readFileSync(
      new URL(
        "../../docs/examples/desktop_ipc_manual_speed.example.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as { payload: Record<string, unknown>; response: { value: unknown } };
  assertManualSpeedRequest(example.payload);
  assertManualSpeedRequest({ ...example.payload, speed: 1 });
  for (const speed of [0, 1.5, 5, 16, "2", null])
    assert.throws(() =>
      assertManualSpeedRequest({ ...example.payload, speed }),
    );
  assert.throws(() =>
    assertManualSpeedRequest({ ...example.payload, endUs: 200_000 }),
  );
  assert.throws(() =>
    assertManualSpeedRequest({ ...example.payload, path: "/private" }),
  );
  assertProjectDraftView(example.response.value);
  const value = example.response.value as unknown as {
    clips: Record<string, unknown>[];
  };
  const withClip = (index: number, change: Record<string, unknown>) => ({
    ...value,
    clips: value.clips.map((clip, at) =>
      at === index ? { ...clip, ...change } : clip,
    ),
  });
  for (const bad of [
    withClip(1, { speed: 1 }),
    withClip(1, { speed: 5 }),
    withClip(1, { speed: 3 }),
    withClip(0, { speed: 2 }),
  ])
    assert.throws(() => assertProjectDraftView(bad));
});
