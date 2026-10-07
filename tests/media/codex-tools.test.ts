import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  CodexVideoEditToolError,
  CodexVideoEditToolService,
} from "../../packages/codex-tools/src/service.ts";
import { MediaLibrary } from "../../packages/media-engine/src/library.ts";
import { runProcess } from "../../packages/media-engine/src/process.ts";
import type { TranscriptionProjectView } from "../../packages/domain/src/transcription.ts";
import { ProjectStore } from "../../packages/project-store/src/store.ts";
import {
  DraftTransactionStore,
  type DraftTransactionDependencies,
} from "../../packages/project-store/src/transactions.ts";

async function fixture(
  dependencyOverrides: Partial<DraftTransactionDependencies> = {},
) {
  const base = resolve("test-results/codex-tools");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, "fixture-"));
  const source = join(root, "private-source.mkv");
  await runProcess({
    executable: "ffmpeg",
    args: [
      "-v",
      "error",
      "-nostdin",
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=16x16:rate=30:duration=1",
      "-c:v",
      "ffv1",
      "-pix_fmt",
      "bgra",
      source,
    ],
  });
  const library = new MediaLibrary(join(root, "library"));
  const media = await library.importFile(source);
  const projectsRoot = join(root, "projects");
  const projects = new ProjectStore(projectsRoot, library);
  const active = await projects.createFromMedia(media.id);
  const other = await projects.createFromMedia(media.id);
  let next = 0;
  const dependencies: Partial<DraftTransactionDependencies> = {
    now: () => "2026-09-12T12:00:00.000Z",
    id: () => `tool-generated-${String(++next).padStart(3, "0")}`,
    ...dependencyOverrides,
  };
  const drafts = new DraftTransactionStore(
    projectsRoot,
    projects,
    dependencies,
  );
  const service = new CodexVideoEditToolService(
    active.project.project_id,
    drafts,
  );
  return {
    root,
    source,
    active,
    other,
    projects,
    projectsRoot,
    drafts,
    service,
  };
}

function readInput(projectId: string) {
  return { schema_version: "1.0", project_id: projectId };
}

function trimInput(
  draft: Awaited<ReturnType<DraftTransactionStore["snapshot"]>>["draft"],
) {
  return {
    schema_version: "1.0",
    request_id: "codex-trim-request-001",
    project_id: draft.project_id,
    draft_id: draft.draft_id,
    base_revision_id: draft.base_revision_id,
    expected_sequence: draft.draft_sequence,
    expected_timeline_sha256: draft.timeline_sha256,
    pass_group_id: "codex-spoken-cut-001",
    reason: "Remove the false start while preserving the source.",
    clip_id: draft.timeline.clips[0]!.clip_id,
    edge: "start",
    timeline_position_us: 200_000,
  };
}

function rangeInput(
  draft: Awaited<ReturnType<DraftTransactionStore["snapshot"]>>["draft"],
) {
  return {
    schema_version: "1.0",
    request_id: "codex-range-request-001",
    project_id: draft.project_id,
    draft_id: draft.draft_id,
    base_revision_id: draft.base_revision_id,
    expected_sequence: draft.draft_sequence,
    expected_timeline_sha256: draft.timeline_sha256,
    pass_group_id: "codex-spoken-cut-001",
    reason: "Remove the selected false start while preserving the source.",
    start_us: 200_000,
    end_us: 600_000,
  };
}

function restoreInput(
  draft: Awaited<ReturnType<DraftTransactionStore["snapshot"]>>["draft"],
  sourceId = draft.timeline.clips[0]!.source_id,
) {
  return {
    schema_version: "1.0",
    request_id: "codex-restore-request-001",
    project_id: draft.project_id,
    draft_id: draft.draft_id,
    base_revision_id: draft.base_revision_id,
    expected_sequence: draft.draft_sequence,
    expected_timeline_sha256: draft.timeline_sha256,
    pass_group_id: "codex-spoken-cut-001",
    reason:
      "Restore the reviewed source interval that is missing from the cut.",
    source_id: sourceId,
    source_start_us: 200_000,
    source_end_us: 400_000,
  };
}

function splitInput(
  draft: Awaited<ReturnType<DraftTransactionStore["snapshot"]>>["draft"],
) {
  return {
    schema_version: "1.0",
    request_id: "codex-split-request-001",
    project_id: draft.project_id,
    draft_id: draft.draft_id,
    base_revision_id: draft.base_revision_id,
    expected_sequence: draft.draft_sequence,
    expected_timeline_sha256: draft.timeline_sha256,
    pass_group_id: "codex-spoken-cut-001",
    reason: "Divide the current clip at this reviewed beat.",
    clip_id: draft.timeline.clips[0]!.clip_id,
    timeline_position_us: 400_000,
  };
}

function expectCode(expected: CodexVideoEditToolError["code"]) {
  return (error: unknown) =>
    error instanceof CodexVideoEditToolError && error.code === expected;
}

function serialized(value: unknown): string {
  return JSON.stringify(value).toLowerCase();
}

test("bounded project and timeline summaries omit private persistence and probe data", async () => {
  const { active, service } = await fixture();
  const project = await service.invoke(
    "project.get_summary",
    readInput(active.project.project_id),
  );
  const timeline = await service.invoke(
    "timeline.get_summary",
    readInput(active.project.project_id),
  );
  assert.equal(
    (project as { project_id: string }).project_id,
    active.project.project_id,
  );
  assert.equal((timeline as { draft_sequence: number }).draft_sequence, 0);
  for (const output of [project, timeline]) {
    const json = serialized(output);
    assert.doesNotMatch(
      json,
      /original_path|managed_path|project_root|source_probe/u,
    );
    assert.doesNotMatch(json, /\\|\/fixture-/u);
    assert.doesNotMatch(
      json,
      /sha256.*private-source|codec_long_name|format_name/u,
    );
  }
});

test("Codex trim and newest undo return only committed draft authority", async () => {
  const { source, active, drafts, service } = await fixture();
  const sourceBefore = await readFile(source);
  const managedBefore = await readFile(active.source.managed_path);
  const initial = await drafts.snapshot(active.project.project_id);
  const applied = (await service.invoke(
    "cut.trim_edge",
    trimInput(initial.draft),
  )) as {
    status: string;
    transaction_id: string;
    applied_operation_ids: string[];
    draft: { draft_sequence: number; duration_us: number };
    undo_token: string;
  };
  assert.equal(applied.status, "committed");
  assert.equal(applied.draft.draft_sequence, 1);
  assert.equal(applied.draft.duration_us, 800_000);
  assert.equal(applied.applied_operation_ids.length, 1);
  assert.equal(applied.undo_token, applied.transaction_id);
  assert.doesNotMatch(
    serialized(applied),
    /inverse|before|created_at|origin|original_path|managed_path/u,
  );
  const current = await drafts.snapshot(active.project.project_id);
  const undone = (await service.invoke("timeline.undo", {
    schema_version: "1.0",
    request_id: "codex-undo-request-001",
    project_id: current.draft.project_id,
    draft_id: current.draft.draft_id,
    base_revision_id: current.draft.base_revision_id,
    expected_sequence: current.draft.draft_sequence,
    expected_timeline_sha256: current.draft.timeline_sha256,
    target_transaction_id: applied.transaction_id,
    reason: "Restore the newest draft edit.",
  })) as {
    status: string;
    draft: { draft_sequence: number; duration_us: number };
  };
  assert.equal(undone.status, "committed");
  assert.equal(undone.draft.draft_sequence, 2);
  assert.equal(undone.draft.duration_us, 1_000_000);
  assert.deepEqual(await readFile(source), sourceBefore);
  assert.deepEqual(await readFile(active.source.managed_path), managedBefore);
});

test("Codex split commits the shared deterministic journal and newest undo restores the exact clip", async () => {
  const { root, source, active, projects, projectsRoot, drafts, service } =
    await fixture();
  const sourceBefore = await readFile(source);
  const managedBefore = await readFile(active.source.managed_path);
  const baselinePath = join(
    projectsRoot,
    active.project.project_id,
    "baseline.json",
  );
  const baselineBefore = await readFile(baselinePath);
  const initial = await drafts.snapshot(active.project.project_id);
  const applied = (await service.invoke(
    "cut.split",
    splitInput(initial.draft),
  )) as {
    status: string;
    transaction_id: string;
    applied_operation_ids: string[];
    draft: {
      draft_sequence: number;
      duration_us: number;
      clips: Array<{
        clip_id: string;
        source_start_us: number;
        source_end_us: number;
        timeline_start_us: number;
        timeline_end_us: number;
      }>;
    };
  };
  assert.equal(applied.status, "committed");
  assert.equal(applied.draft.draft_sequence, 1);
  assert.equal(applied.draft.duration_us, 1_000_000);
  assert.equal(applied.applied_operation_ids.length, 1);
  assert.equal(applied.draft.clips.length, 2);
  assert.equal(
    applied.draft.clips[0]!.clip_id,
    initial.draft.timeline.clips[0]!.clip_id,
  );
  assert.match(applied.draft.clips[1]!.clip_id, /^clip-[a-f0-9]{32}$/u);
  assert.deepEqual(
    applied.draft.clips.map((clip) => [
      clip.source_start_us,
      clip.source_end_us,
      clip.timeline_start_us,
      clip.timeline_end_us,
    ]),
    [
      [0, 400_000, 0, 400_000],
      [400_000, 1_000_000, 400_000, 1_000_000],
    ],
  );
  assert.doesNotMatch(
    serialized(applied),
    /inverse|before|origin|managed_path/u,
  );
  const journal = join(
    root,
    "projects",
    active.project.project_id,
    "draft",
    "journal",
  );
  const entries = await readdir(journal);
  assert.equal(entries.length, 1);
  const record = JSON.parse(
    await readFile(join(journal, entries[0]!), "utf8"),
  ) as {
    origin: string;
    pass_group: { kind: string };
    operations: Array<{ operation_type: string }>;
  };
  assert.equal(record.origin, "codex");
  assert.equal(record.pass_group.kind, "spoken_cut");
  assert.equal(record.operations[0]?.operation_type, "split");
  const reopened = await new DraftTransactionStore(
    projectsRoot,
    projects,
  ).snapshot(active.project.project_id);
  assert.equal(reopened.draft.draft_sequence, 1);
  assert.deepEqual(
    reopened.draft.timeline.clips,
    (await drafts.snapshot(active.project.project_id)).draft.timeline.clips,
  );
  const undone = (await service.invoke("timeline.undo", {
    schema_version: "1.0",
    request_id: "codex-split-undo-001",
    project_id: reopened.draft.project_id,
    draft_id: reopened.draft.draft_id,
    base_revision_id: reopened.draft.base_revision_id,
    expected_sequence: reopened.draft.draft_sequence,
    expected_timeline_sha256: reopened.draft.timeline_sha256,
    target_transaction_id: applied.transaction_id,
    reason: "Restore the clip before the split.",
  })) as { draft: { draft_sequence: number; clips: unknown[] } };
  assert.equal(undone.draft.draft_sequence, 2);
  assert.deepEqual(undone.draft.clips, initial.draft.timeline.clips);
  assert.deepEqual(await readFile(source), sourceBefore);
  assert.deepEqual(await readFile(active.source.managed_path), managedBefore);
  assert.deepEqual(await readFile(baselinePath), baselineBefore);
});

test("API-provider split injects its origin and rejects unsafe or stale intent", async () => {
  const { root, active, drafts, service } = await fixture();
  const provider = new CodexVideoEditToolService(
    active.project.project_id,
    drafts,
    "api_provider",
  );
  const initial = await drafts.snapshot(active.project.project_id);
  const input = splitInput(initial.draft);
  for (const invalid of [
    { timeline_position_us: 0 },
    { timeline_position_us: -1 },
    { timeline_position_us: 0.5 },
    { source_path: "private-media.mp4" },
    { origin: "manual" },
    { operations: [{ type: "source_delete" }] },
  ]) {
    await assert.rejects(
      provider.invoke("cut.split", { ...input, ...invalid }),
      expectCode("invalid_request"),
    );
  }
  for (const boundary of [1_000_000, 1_000_001]) {
    await assert.rejects(
      provider.invoke("cut.split", {
        ...input,
        timeline_position_us: boundary,
      }),
      expectCode("edit_conflict"),
    );
  }
  const applied = (await provider.invoke("cut.split", input)) as {
    draft: { draft_sequence: number; clips: unknown[] };
  };
  assert.equal(applied.draft.draft_sequence, 1);
  assert.equal(applied.draft.clips.length, 2);
  const journal = join(
    root,
    "projects",
    active.project.project_id,
    "draft",
    "journal",
  );
  const entries = await readdir(journal);
  assert.equal(entries.length, 1);
  const record = JSON.parse(
    await readFile(join(journal, entries[0]!), "utf8"),
  ) as {
    origin: string;
    operations: Array<{ operation_type: string }>;
  };
  assert.equal(record.origin, "api_provider");
  assert.equal(record.operations[0]?.operation_type, "split");
  await assert.rejects(
    service.invoke("cut.split", {
      ...input,
      request_id: "codex-stale-split-002",
    }),
    expectCode("stale_draft"),
  );
});

test("Codex range cut uses the shared ripple transaction and newest undo", async () => {
  const { root, source, active, drafts, service } = await fixture();
  const sourceBefore = await readFile(source);
  const managedBefore = await readFile(active.source.managed_path);
  const initial = await drafts.snapshot(active.project.project_id);
  const applied = (await service.invoke(
    "cut.delete_range",
    rangeInput(initial.draft),
  )) as {
    status: string;
    transaction_id: string;
    draft: { draft_sequence: number; duration_us: number; clips: unknown[] };
  };
  assert.equal(applied.status, "committed");
  assert.equal(applied.draft.draft_sequence, 1);
  assert.equal(applied.draft.duration_us, 600_000);
  assert.equal(applied.draft.clips.length, 2);
  assert.doesNotMatch(
    serialized(applied),
    /inverse|before|origin|managed_path/u,
  );
  const journal = join(
    root,
    "projects",
    active.project.project_id,
    "draft",
    "journal",
  );
  const entries = await readdir(journal);
  assert.equal(entries.length, 1);
  const record = JSON.parse(
    await readFile(join(journal, entries[0]!), "utf8"),
  ) as {
    origin: string;
    pass_group: { kind: string };
    operations: Array<{ operation_type: string }>;
  };
  assert.equal(record.origin, "codex");
  assert.equal(record.pass_group.kind, "spoken_cut");
  assert.equal(record.operations[0]?.operation_type, "ripple_delete");
  const current = await drafts.snapshot(active.project.project_id);
  const undone = (await service.invoke("timeline.undo", {
    schema_version: "1.0",
    request_id: "codex-range-undo-001",
    project_id: current.draft.project_id,
    draft_id: current.draft.draft_id,
    base_revision_id: current.draft.base_revision_id,
    expected_sequence: current.draft.draft_sequence,
    expected_timeline_sha256: current.draft.timeline_sha256,
    target_transaction_id: applied.transaction_id,
    reason: "Restore the newest range cut.",
  })) as { draft: { draft_sequence: number; duration_us: number } };
  assert.equal(undone.draft.draft_sequence, 2);
  assert.equal(undone.draft.duration_us, 1_000_000);
  assert.deepEqual(await readFile(source), sourceBefore);
  assert.deepEqual(await readFile(active.source.managed_path), managedBefore);
});

test("API-provider range cut routes to the API origin and rejects unsafe ranges", async () => {
  const { root, active, drafts, service } = await fixture();
  const provider = new CodexVideoEditToolService(
    active.project.project_id,
    drafts,
    "api_provider",
  );
  const initial = await drafts.snapshot(active.project.project_id);
  const input = rangeInput(initial.draft);
  for (const invalid of [
    { start_us: -1 },
    { start_us: 600_000, end_us: 600_000 },
    { start_us: 700_000, end_us: 600_000 },
    { start_us: 0.5 },
    { source_path: "private-media.mp4" },
    { origin: "manual" },
    { operations: [{ type: "source_delete" }] },
  ]) {
    await assert.rejects(
      provider.invoke("cut.delete_range", { ...input, ...invalid }),
      expectCode("invalid_request"),
    );
  }
  await assert.rejects(
    provider.invoke("cut.delete_range", {
      ...input,
      start_us: 0,
      end_us: 1_000_000,
    }),
    expectCode("edit_conflict"),
  );
  const applied = (await provider.invoke("cut.delete_range", input)) as {
    draft: { draft_sequence: number; duration_us: number };
  };
  assert.equal(applied.draft.draft_sequence, 1);
  assert.equal(applied.draft.duration_us, 600_000);
  const journal = join(
    root,
    "projects",
    active.project.project_id,
    "draft",
    "journal",
  );
  const entries = await readdir(journal);
  assert.equal(entries.length, 1);
  const record = JSON.parse(
    await readFile(join(journal, entries[0]!), "utf8"),
  ) as {
    origin: string;
  };
  assert.equal(record.origin, "api_provider");
  await assert.rejects(
    service.invoke("cut.delete_range", {
      ...input,
      request_id: "codex-stale-range-002",
    }),
    expectCode("stale_draft"),
  );
});

test("guarded range batch is one reversible commit and rejects unsafe order", async () => {
  const { active, drafts, service } = await fixture();
  const initial = (await drafts.snapshot(active.project.project_id)).draft;
  const base: Record<string, unknown> = structuredClone(rangeInput(initial));
  delete base.start_us;
  delete base.end_us;
  const input = {
    ...base,
    request_id: "codex-range-batch-001",
    ranges: [
      { start_us: 700_000, end_us: 800_000 },
      { start_us: 100_000, end_us: 200_000 },
    ],
  };
  for (const ranges of [
    input.ranges.toReversed(),
    [
      { start_us: 700_000, end_us: 800_000 },
      { start_us: 650_000, end_us: 750_000 },
    ],
    [{ start_us: 700_000, end_us: 800_000 }],
  ])
    await assert.rejects(
      service.invoke("cut.delete_ranges", { ...input, ranges }),
      expectCode("invalid_request"),
    );
  assert.equal(
    (await drafts.snapshot(initial.project_id)).draft.draft_sequence,
    0,
  );
  const applied = (await service.invoke("cut.delete_ranges", input)) as {
    transaction_id: string;
    draft: { draft_sequence: number; duration_us: number };
    applied_operation_ids: string[];
  };
  assert.equal(applied.draft.draft_sequence, 1);
  assert.equal(applied.draft.duration_us, 800_000);
  assert.equal(applied.applied_operation_ids.length, 2);
  const replay = (await service.invoke("cut.delete_ranges", input)) as {
    replayed: boolean;
  };
  assert.equal(replay.replayed, true);
  const current = (await drafts.snapshot(initial.project_id)).draft;
  await assert.rejects(
    service.invoke("cut.delete_ranges", {
      ...input,
      request_id: "codex-range-batch-stale",
      ranges: input.ranges,
    }),
    expectCode("stale_draft"),
  );
  const undone = (await service.invoke("timeline.undo", {
    schema_version: "1.0",
    request_id: "codex-range-batch-undo",
    project_id: current.project_id,
    draft_id: current.draft_id,
    base_revision_id: current.base_revision_id,
    expected_sequence: current.draft_sequence,
    expected_timeline_sha256: current.timeline_sha256,
    target_transaction_id: applied.transaction_id,
    reason: "Restore both confirmed ranges.",
  })) as { draft: { duration_us: number; draft_sequence: number } };
  assert.equal(undone.draft.duration_us, 1_000_000);
  assert.equal(undone.draft.draft_sequence, 2);
});

test("guarded restore_range uses source coordinates, exact freshness, and the shared journal", async () => {
  const { active, source, projectsRoot, drafts, service } = await fixture();
  const baselinePath = join(
    projectsRoot,
    active.project.project_id,
    "baseline.json",
  );
  const [sourceBytes, baselineBytes] = await Promise.all([
    readFile(source),
    readFile(baselinePath),
  ]);
  const initial = (await drafts.snapshot(active.project.project_id)).draft;
  const cut = (await service.invoke("cut.delete_range", {
    ...rangeInput(initial),
    start_us: 200_000,
    end_us: 400_000,
  })) as { draft: { draft_sequence: number; timeline_sha256: string } };
  const cutDraft = (await drafts.snapshot(active.project.project_id)).draft;
  assert.equal(cut.draft.draft_sequence, 1);
  assert.equal(cutDraft.timeline_sha256, cut.draft.timeline_sha256);
  const input = restoreInput(cutDraft);
  await assert.rejects(
    service.invoke("cut.restore_range", {
      ...input,
      source_start_us: 0,
      source_end_us: 200_000,
    }),
    expectCode("edit_conflict"),
  );
  assert.equal(
    (await drafts.snapshot(active.project.project_id)).draft.draft_sequence,
    1,
  );
  const restored = (await service.invoke("cut.restore_range", input)) as {
    transaction_id: string;
    draft: {
      draft_sequence: number;
      duration_us: number;
      clips: { source_start_us: number; source_end_us: number }[];
    };
  };
  assert.equal(restored.draft.draft_sequence, 2);
  assert.equal(restored.draft.duration_us, 1_000_000);
  assert.deepEqual(
    restored.draft.clips.map((clip) => [
      clip.source_start_us,
      clip.source_end_us,
    ]),
    [
      [0, 200_000],
      [200_000, 400_000],
      [400_000, 1_000_000],
    ],
  );
  const journal = join(
    projectsRoot,
    active.project.project_id,
    "draft",
    "journal",
  );
  const record = JSON.parse(
    await readFile(
      join(journal, "000000000002." + restored.transaction_id + ".json"),
      "utf8",
    ),
  ) as { origin: string; operations: { operation_type: string }[] };
  assert.equal(record.origin, "codex");
  assert.equal(record.operations[0]?.operation_type, "restore");
  await assert.rejects(
    service.invoke("cut.restore_range", {
      ...input,
      request_id: "codex-restore-stale-001",
    }),
    expectCode("stale_draft"),
  );
  assert.deepEqual(
    await Promise.all([readFile(source), readFile(baselinePath)]),
    [sourceBytes, baselineBytes],
  );
});

test("API-provider restore uses the same active draft journal and Undo", async () => {
  const { active, source, projectsRoot, drafts, service } = await fixture();
  const baselinePath = join(
    projectsRoot,
    active.project.project_id,
    "baseline.json",
  );
  const [baselineBytes, sourceBytes] = await Promise.all([
    readFile(baselinePath),
    readFile(source),
  ]);
  const initial = (await drafts.snapshot(active.project.project_id)).draft;
  await service.invoke("cut.delete_range", {
    ...rangeInput(initial),
    start_us: 200_000,
    end_us: 400_000,
  });
  const missing = (await drafts.snapshot(active.project.project_id)).draft;
  const api = new CodexVideoEditToolService(
    active.project.project_id,
    drafts,
    "api_provider",
  );
  const input = {
    ...restoreInput(missing),
    request_id: "api-restore-request-001",
  };
  const restored = (await api.invoke("cut.restore_range", input)) as {
    transaction_id: string;
    draft: { draft_sequence: number; duration_us: number };
  };
  assert.equal(restored.draft.draft_sequence, 2);
  assert.equal(restored.draft.duration_us, 1_000_000);
  const head = (await drafts.snapshot(active.project.project_id)).draft;
  const undone = (await api.invoke("timeline.undo", {
    schema_version: "1.0",
    request_id: "api-restore-undo-001",
    project_id: head.project_id,
    draft_id: head.draft_id,
    base_revision_id: head.base_revision_id,
    expected_sequence: head.draft_sequence,
    expected_timeline_sha256: head.timeline_sha256,
    target_transaction_id: restored.transaction_id,
    reason: "Undo the provider restore through the shared journal.",
  })) as { draft: { draft_sequence: number; duration_us: number } };
  assert.equal(undone.draft.draft_sequence, 3);
  assert.equal(undone.draft.duration_us, 800_000);
  const journal = join(
    projectsRoot,
    active.project.project_id,
    "draft",
    "journal",
  );
  const records = (await readdir(journal)).sort();
  assert.equal(records.length, 3);
  const restoreRecord = JSON.parse(
    await readFile(join(journal, records[1]!), "utf8"),
  ) as { origin: string; operations: { operation_type: string }[] };
  assert.equal(restoreRecord.origin, "api_provider");
  assert.equal(restoreRecord.operations[0]?.operation_type, "restore");
  assert.deepEqual(
    await Promise.all([readFile(baselinePath), readFile(source)]),
    [baselineBytes, sourceBytes],
  );
});

test("an undo committed before an uncertain response is idempotent on retry", async () => {
  let commits = 0;
  const { active, drafts, service } = await fixture({
    afterJournalCommit: async () => {
      commits += 1;
      if (commits === 2) throw new Error("response lost after commit");
    },
  });
  const initial = await drafts.snapshot(active.project.project_id);
  const applied = (await service.invoke(
    "cut.trim_edge",
    trimInput(initial.draft),
  )) as { transaction_id: string };
  const current = await drafts.snapshot(active.project.project_id);
  const request = {
    schema_version: "1.0",
    request_id: "codex-undo-retry-001",
    project_id: current.draft.project_id,
    draft_id: current.draft.draft_id,
    base_revision_id: current.draft.base_revision_id,
    expected_sequence: current.draft.draft_sequence,
    expected_timeline_sha256: current.draft.timeline_sha256,
    target_transaction_id: applied.transaction_id,
    reason: "Restore the newest edit after an uncertain response.",
  };
  await assert.rejects(
    service.invoke("timeline.undo", request),
    expectCode("outcome_unknown"),
  );
  const replay = (await service.invoke("timeline.undo", request)) as {
    replayed: boolean;
    draft: { draft_sequence: number; duration_us: number };
  };
  assert.equal(replay.replayed, true);
  assert.equal(replay.draft.draft_sequence, 2);
  assert.equal(replay.draft.duration_us, 1_000_000);
});

test("inactive, stale, excess, path, source-mutation, and arbitrary tools fail closed", async () => {
  const { active, other, drafts, service } = await fixture();
  const initial = await drafts.snapshot(active.project.project_id);
  const otherInitial = await drafts.snapshot(other.project.project_id);
  await assert.rejects(
    service.invoke("project.get_summary", readInput(other.project.project_id)),
    expectCode("inactive_project"),
  );
  // A model that mistyped the ID is told the one project it may use.
  await assert.rejects(
    service.invoke("project.get_summary", readInput(other.project.project_id)),
    (error: Error) =>
      error.message ===
      `That project is not the active project. The active project_id is "${active.project.project_id}".`,
  );
  await assert.rejects(
    service.invoke("cut.trim_edge", trimInput(otherInitial.draft)),
    expectCode("inactive_project"),
  );
  for (const forbidden of [
    { source_path: "C:\\Users\\private\\recording.mp4" },
    { origin: "codex" },
    { transaction_id: "caller-transaction-001" },
    { operation_id: "caller-operation-001" },
    { created_at: "2026-09-12T12:00:00.000Z" },
    { inverse: { type: "restore_source" } },
  ]) {
    await assert.rejects(
      service.invoke("cut.trim_edge", {
        ...trimInput(initial.draft),
        ...forbidden,
      }),
      expectCode("invalid_request"),
    );
  }
  await assert.rejects(
    service.invoke("project.get_summary", {
      ...readInput(active.project.project_id),
      path: "C:\\Users\\private\\recording.mp4",
    }),
    expectCode("invalid_request"),
  );
  for (const name of [
    "source.overwrite",
    "project.delete",
    "export.confirm",
    "cleanup.run",
    "shell.exec",
    "rpc.call",
    "timeline.apply_operations",
  ]) {
    await assert.rejects(
      service.invoke(name, readInput(active.project.project_id)),
      expectCode("tool_not_available"),
    );
  }
  await service.invoke("cut.trim_edge", trimInput(initial.draft));
  await assert.rejects(
    service.invoke("cut.trim_edge", {
      ...trimInput(initial.draft),
      request_id: "codex-stale-request-002",
    }),
    expectCode("stale_draft"),
  );
  assert.equal(
    (await drafts.snapshot(other.project.project_id)).draft.draft_sequence,
    0,
  );
  assert.equal(
    (await drafts.snapshot(active.project.project_id)).draft.draft_sequence,
    1,
  );
});

test("unexpected backend details are replaced with a fixed safe error", async () => {
  const activeProjectId = "active-project-001";
  const service = new CodexVideoEditToolService(activeProjectId, {
    snapshotWithProject: async () => {
      throw new Error(
        "C:\\Users\\private\\recording.mp4 transcript=private protocol=raw token=secret-123",
      );
    },
    snapshot: async () => {
      throw new Error("probe stderr /private/source.mp4");
    },
    applyCodex: async () => {
      throw new Error("unreachable");
    },
    undoCodex: async () => {
      throw new Error("unreachable");
    },
  });
  await assert.rejects(
    service.invoke("project.get_summary", readInput(activeProjectId)),
    (error: unknown) => {
      assert.ok(error instanceof CodexVideoEditToolError);
      assert.equal(error.code, "service_unavailable");
      assert.equal(
        error.message,
        "The editing service is unavailable. Reopen the project and try again.",
      );
      assert.doesNotMatch(
        error.message,
        /private|token|probe|transcript|protocol|\.mp4/u,
      );
      return true;
    },
  );
});

test("transcript.get_range returns bounded path-free source words and stable page identity", async () => {
  const { active, drafts } = await fixture();
  const projectId = active.project.project_id;
  const sourceId = active.source.source_id;
  const transcriptId = "transcript-local-001";
  const transcriptView: TranscriptionProjectView = {
    project_id: projectId,
    job: {
      project_id: projectId,
      job_id: "transcription-local-001",
      status: "completed",
      progress_percent: 100,
      source_count: 1,
      completed_source_count: 1,
      word_count: 4,
      message: "Transcript ready.",
    },
    results: [
      {
        source_id: sourceId,
        transcript: {
          schema_version: "1.0",
          transcript_id: transcriptId,
          project_id: projectId,
          source_id: sourceId,
          duration_us: active.source.duration_us,
          language: "en",
          model: { provider: "local", name: "fixture", version: "1" },
          segments: [
            {
              segment_id: "transcript-segment-001",
              start_us: 100_000,
              end_us: 600_000,
              text: "Um use the panel",
              words: [
                {
                  word_id: "transcript-word-001",
                  text: "Um",
                  start_us: 100_000,
                  end_us: 180_000,
                  confidence: 0.4,
                  flags: ["uncertain"],
                },
                {
                  word_id: "transcript-word-002",
                  text: "use",
                  start_us: 220_000,
                  end_us: 300_000,
                  confidence: 0.95,
                  flags: [],
                },
                {
                  word_id: "transcript-word-003",
                  text: "the",
                  start_us: 400_000,
                  end_us: 450_000,
                  confidence: null,
                  flags: [],
                },
                {
                  word_id: "transcript-word-004",
                  text: "panel",
                  start_us: 500_000,
                  end_us: 600_000,
                  confidence: null,
                  flags: ["name"],
                },
              ],
            },
          ],
          warnings: [],
        },
        analysis: {
          schema_version: "1.0",
          project_id: projectId,
          source_id: sourceId,
          source_sha256: active.source.sha256,
          duration_us: active.source.duration_us,
          silence_policy: {
            version: "1",
            noise_db: -40,
            minimum_duration_us: 250_000,
          },
          silences: [],
        },
      },
    ],
  };
  const service = new CodexVideoEditToolService(
    projectId,
    drafts,
    "codex",
    async (requestedProjectId) => {
      assert.equal(requestedProjectId, projectId);
      return transcriptView;
    },
  );
  const request = {
    schema_version: "1.0",
    project_id: projectId,
    source_id: sourceId,
    source_start_us: 100_000,
    source_end_us: 500_000,
    offset: 0,
    limit: 2,
  };
  const first = (await service.invoke("transcript.get_range", request)) as {
    transcript_id: string;
    source_sha256: string;
    total_word_count: number;
    next_offset: number | null;
    draft: { draft_sequence: number };
    words: Array<Record<string, unknown>>;
  };
  assert.equal(first.transcript_id, transcriptId);
  assert.equal(first.source_sha256, active.source.sha256);
  assert.equal(first.total_word_count, 3);
  assert.equal(first.next_offset, 2);
  assert.equal(first.draft.draft_sequence, 0);
  assert.deepEqual(
    first.words.map((word) => word.word_id),
    ["transcript-word-001", "transcript-word-002"],
  );
  assert.equal(first.words[0]?.asr_text, "Um");
  assert.deepEqual(first.words[0]?.flags, ["uncertain"]);
  assert.equal(first.words[0]?.transcript_override_text, null);
  assert.doesNotMatch(
    JSON.stringify(first),
    /private-source|original_path|managed_path|project_root/u,
  );

  const second = (await service.invoke("transcript.get_range", {
    ...request,
    transcript_id: first.transcript_id,
    offset: first.next_offset!,
  })) as { next_offset: number | null; words: Array<Record<string, unknown>> };
  assert.equal(second.next_offset, null);
  assert.deepEqual(
    second.words.map((word) => word.word_id),
    ["transcript-word-003"],
  );
  const beforeCorrection = await drafts.snapshot(projectId);
  const sourceBeforeCorrection = await readFile(active.source.managed_path);
  await drafts.applyCodex({
    schema_version: "1.0",
    request_id: "codex-transcript-override-001",
    project_id: projectId,
    draft_id: beforeCorrection.draft.draft_id,
    base_revision_id: beforeCorrection.draft.base_revision_id,
    expected_sequence: beforeCorrection.draft.draft_sequence,
    expected_timeline_sha256: beforeCorrection.draft.timeline_sha256,
    pass_group: { pass_group_id: "codex-spoken-cut-001", kind: "spoken_cut" },
    reason: "Correct transcript display text only.",
    operations: [
      {
        type: "transcript_edit",
        source_id: sourceId,
        transcript_id: transcriptId,
        word_id: "transcript-word-001",
        original_text: "Um",
        expected_text: "Um",
        replacement_text: "Hmm",
      },
    ],
  });
  const correctedPage = (await service.invoke(
    "transcript.get_range",
    request,
  )) as {
    draft: { draft_sequence: number };
    words: Array<Record<string, unknown>>;
  };
  assert.equal(correctedPage.words[0]?.asr_text, "Um");
  assert.equal(correctedPage.words[0]?.transcript_override_text, "Hmm");
  assert.equal(correctedPage.draft.draft_sequence, 1);
  assert.deepEqual(
    await readFile(active.source.managed_path),
    sourceBeforeCorrection,
  );
  await assert.rejects(
    service.invoke("transcript.get_range", {
      ...request,
      transcript_id: "transcript-stale-001",
    }),
    expectCode("transcript_unavailable"),
  );
  await assert.rejects(
    service.invoke("transcript.get_range", { ...request, limit: 251 }),
    expectCode("invalid_request"),
  );
});

test("Claude-origin split and undo are attributed in the shared journal", async () => {
  const { root, active, drafts } = await fixture();
  const claude = new CodexVideoEditToolService(
    active.project.project_id,
    drafts,
    "claude",
  );
  const initial = await drafts.snapshot(active.project.project_id);
  const applied = (await claude.invoke(
    "cut.split",
    splitInput(initial.draft),
  )) as {
    transaction_id: string;
    draft: { draft_sequence: number; clips: unknown[] };
  };
  assert.equal(applied.draft.clips.length, 2);
  const current = await drafts.snapshot(active.project.project_id);
  await claude.invoke("timeline.undo", {
    schema_version: "1.0",
    request_id: "claude-undo-001",
    project_id: active.project.project_id,
    draft_id: current.draft.draft_id,
    base_revision_id: current.draft.base_revision_id,
    expected_sequence: current.draft.draft_sequence,
    expected_timeline_sha256: current.draft.timeline_sha256,
    target_transaction_id: applied.transaction_id,
    reason: "Restore the clip before the split.",
  });
  const journal = join(
    root,
    "projects",
    active.project.project_id,
    "draft",
    "journal",
  );
  const origins = await Promise.all(
    (await readdir(journal)).map(
      async (name) =>
        (
          JSON.parse(await readFile(join(journal, name), "utf8")) as {
            origin: string;
          }
        ).origin,
    ),
  );
  assert.deepEqual(origins, ["claude", "claude"]);
});

type Snapshot = Awaited<ReturnType<DraftTransactionStore["snapshot"]>>;
type ToolDraft = {
  draft_sequence: number;
  duration_us: number;
  clips: Array<{
    source_start_us: number;
    source_end_us: number;
    timeline_start_us: number;
    timeline_end_us: number;
    speed?: number;
  }>;
  zooms: Array<{
    zoom_id: string;
    source_id: string;
    source_start_us: number;
    source_end_us: number;
    center_x: number;
    center_y: number;
    scale: number;
    timeline_ranges: Array<{ start_us: number; end_us: number }>;
  }>;
};
type ToolCommit = { transaction_id: string; draft: ToolDraft };

function head(snapshot: Snapshot, requestId: string) {
  return {
    schema_version: "1.0",
    request_id: requestId,
    project_id: snapshot.draft.project_id,
    draft_id: snapshot.draft.draft_id,
    base_revision_id: snapshot.draft.base_revision_id,
    expected_sequence: snapshot.draft.draft_sequence,
    expected_timeline_sha256: snapshot.draft.timeline_sha256,
    reason: "Apply the edit the user asked for.",
  };
}

function zoomInput(snapshot: Snapshot, requestId: string) {
  return {
    ...head(snapshot, requestId),
    pass_group_id: "assistant-zoom-001",
    start_us: 100_000,
    end_us: 700_000,
    center_x: 0.25,
    center_y: 0.75,
    scale: 2,
  };
}

function speedInput(snapshot: Snapshot, requestId: string, speed: number) {
  return {
    ...head(snapshot, requestId),
    pass_group_id: "assistant-speed-001",
    start_us: 0,
    end_us: snapshot.draft.timeline.duration_us,
    speed,
  };
}

async function journalRecords(root: string, projectId: string) {
  const journal = join(root, "projects", projectId, "draft", "journal");
  return Promise.all(
    (await readdir(journal)).sort().map(
      async (name) =>
        JSON.parse(await readFile(join(journal, name), "utf8")) as {
          origin: string;
          kind: string;
          pass_group: { kind: string } | null;
          operations: Array<{ operation_type: string }>;
        },
    ),
  );
}

function journalSummary(
  record: Awaited<ReturnType<typeof journalRecords>>[number],
) {
  return [
    record.origin,
    record.kind,
    record.pass_group?.kind ?? null,
    record.operations[0]?.operation_type ?? null,
  ];
}

test("zoom.set maps output time to one source, keeps a changed zoom's range, and shares Undo", async () => {
  const { root, source, active, drafts, service } = await fixture();
  const projectId = active.project.project_id;
  const sourceBefore = await readFile(source);
  const managedBefore = await readFile(active.source.managed_path);
  const claude = new CodexVideoEditToolService(projectId, drafts, "claude");
  const added = (await service.invoke(
    "zoom.set",
    zoomInput(await drafts.snapshot(projectId), "zoom-add-001"),
  )) as ToolCommit;
  assert.equal(added.draft.draft_sequence, 1);
  assert.equal(added.draft.duration_us, 1_000_000);
  assert.equal(added.draft.zooms.length, 1);
  const zoom = added.draft.zooms[0]!;
  assert.match(zoom.zoom_id, /^zoom-[a-f0-9]{32}$/u);
  assert.deepEqual(
    { ...zoom, zoom_id: "" },
    {
      zoom_id: "",
      source_id: active.source.source_id,
      source_start_us: 100_000,
      source_end_us: 700_000,
      center_x: 0.25,
      center_y: 0.75,
      scale: 2,
      timeline_ranges: [{ start_us: 100_000, end_us: 700_000 }],
    },
  );
  // Changing a zoom keeps its source range; the given times are not used.
  const changed = (await claude.invoke("zoom.set", {
    ...zoomInput(await drafts.snapshot(projectId), "zoom-change-001"),
    zoom_id: zoom.zoom_id,
    start_us: 0,
    end_us: 900_000,
    center_x: 0.5,
    scale: 3,
  })) as ToolCommit;
  assert.deepEqual(changed.draft.zooms, [{ ...zoom, center_x: 0.5, scale: 3 }]);
  const undone = (await claude.invoke("timeline.undo", {
    ...head(await drafts.snapshot(projectId), "zoom-undo-001"),
    target_transaction_id: changed.transaction_id,
  })) as ToolCommit;
  assert.deepEqual(undone.draft.zooms, [zoom]);
  const removed = (await claude.invoke("zoom.remove", {
    ...head(await drafts.snapshot(projectId), "zoom-remove-001"),
    pass_group_id: "assistant-zoom-002",
    zoom_id: zoom.zoom_id,
  })) as ToolCommit;
  assert.deepEqual(removed.draft.zooms, []);
  const restored = (await service.invoke("timeline.undo", {
    ...head(await drafts.snapshot(projectId), "zoom-undo-002"),
    target_transaction_id: removed.transaction_id,
  })) as ToolCommit;
  assert.deepEqual(restored.draft.zooms, [zoom]);
  const records = await journalRecords(root, projectId);
  assert.deepEqual(records.map(journalSummary), [
    ["codex", "apply", "zoom", "zoom"],
    ["claude", "apply", "zoom", "zoom"],
    ["claude", "undo", null, null],
    ["claude", "apply", "zoom", "zoom"],
    ["codex", "undo", null, null],
  ]);
  assert.deepEqual(await readFile(source), sourceBefore);
  assert.deepEqual(await readFile(active.source.managed_path), managedBefore);
});

test("speed.set commits a shared speed edit, restores normal speed and zooms map through it", async () => {
  const { root, active, drafts } = await fixture();
  const projectId = active.project.project_id;
  const provider = new CodexVideoEditToolService(
    projectId,
    drafts,
    "api_provider",
  );
  // Output [0, 0.5 s) is source [0, 0.5 s); at 2x it plays in 0.25 s.
  const doubled = (await provider.invoke("speed.set", {
    ...speedInput(await drafts.snapshot(projectId), "speed-set-001", 2),
    end_us: 500_000,
  })) as ToolCommit;
  assert.equal(doubled.draft.duration_us, 750_000);
  assert.deepEqual(
    doubled.draft.clips.map((clip) => [
      clip.source_start_us,
      clip.source_end_us,
      clip.timeline_start_us,
      clip.timeline_end_us,
      clip.speed,
    ]),
    [
      [0, 500_000, 0, 250_000, 2],
      [500_000, 1_000_000, 250_000, 750_000, undefined],
    ],
  );
  // The same speed again is not an edit.
  await assert.rejects(
    provider.invoke("speed.set", {
      ...speedInput(await drafts.snapshot(projectId), "speed-set-002", 2),
      end_us: 250_000,
    }),
    expectCode("edit_conflict"),
  );
  // A zoom across the speed boundary maps each end through its own clip.
  const zoomed = (await provider.invoke("zoom.set", {
    ...zoomInput(await drafts.snapshot(projectId), "speed-zoom-001"),
    start_us: 100_000,
    end_us: 600_000,
  })) as ToolCommit;
  assert.deepEqual(
    zoomed.draft.zooms.map((zoom) => [
      zoom.source_start_us,
      zoom.source_end_us,
      zoom.timeline_ranges,
    ]),
    [
      [
        200_000,
        850_000,
        [
          { start_us: 100_000, end_us: 250_000 },
          { start_us: 250_000, end_us: 600_000 },
        ],
      ],
    ],
  );
  const normal = (await provider.invoke("speed.set", {
    ...speedInput(await drafts.snapshot(projectId), "speed-set-003", 1),
    end_us: 250_000,
  })) as ToolCommit;
  assert.equal(normal.draft.duration_us, 1_000_000);
  assert.ok(normal.draft.clips.every((clip) => clip.speed === undefined));
  const ranges = normal.draft.zooms[0]!.timeline_ranges;
  assert.equal(ranges.at(0)?.start_us, 200_000);
  assert.equal(ranges.at(-1)?.end_us, 850_000);
  const undone = (await provider.invoke("timeline.undo", {
    ...head(await drafts.snapshot(projectId), "speed-undo-001"),
    target_transaction_id: normal.transaction_id,
  })) as ToolCommit;
  assert.equal(undone.draft.duration_us, 750_000);
  assert.equal(undone.draft.clips[0]!.speed, 2);
  const records = await journalRecords(root, projectId);
  assert.deepEqual(records.map(journalSummary), [
    ["api_provider", "apply", "speed", "speed"],
    ["api_provider", "apply", "zoom", "zoom"],
    ["api_provider", "apply", "speed", "speed"],
    ["api_provider", "undo", null, null],
  ]);
});

test("zoom and speed tools reject stale heads, other projects and invalid input", async () => {
  const { active, other, drafts, service } = await fixture();
  const projectId = active.project.project_id;
  const initial = await drafts.snapshot(projectId);
  const zoom = zoomInput(initial, "zoom-invalid-001");
  for (const invalid of [
    { end_us: 599_999 },
    { start_us: 700_000, end_us: 100_000 },
    { start_us: -1 },
    { end_us: 700_000.5 },
    { center_x: 1.01 },
    { center_y: -0.01 },
    { center_x: "0.5" },
    { center_y: Number.POSITIVE_INFINITY },
    { scale: 1 },
    { scale: 4.01 },
    { zoom_id: "../zoom" },
    { zoom_id: null },
    { source_id: initial.draft.timeline.clips[0]!.source_id },
    { origin: "manual" },
    // Past the end of the draft: no footage under the range.
    { start_us: 800_000, end_us: 1_400_000 },
  ])
    await assert.rejects(
      service.invoke("zoom.set", { ...zoom, ...invalid }),
      expectCode("invalid_request"),
    );
  const withoutPass: Record<string, unknown> = { ...zoom };
  delete withoutPass.pass_group_id;
  await assert.rejects(
    service.invoke("zoom.set", withoutPass),
    expectCode("invalid_request"),
  );
  await assert.rejects(
    service.invoke("zoom.set", { ...zoom, zoom_id: "zoom-missing-001" }),
    expectCode("edit_conflict"),
  );
  const speed = speedInput(initial, "speed-invalid-001", 2);
  for (const invalid of [
    { speed: 0 },
    { speed: 5 },
    { speed: 1.5 },
    { speed: "2" },
    { start_us: 500_000, end_us: 500_000 },
    { end_us: 0 },
    { origin: "codex" },
  ])
    await assert.rejects(
      service.invoke("speed.set", { ...speed, ...invalid }),
      expectCode("invalid_request"),
    );
  await assert.rejects(
    service.invoke("speed.set", { ...speed, end_us: 1_000_001 }),
    expectCode("edit_conflict"),
  );
  const remove = {
    ...head(initial, "zoom-remove-invalid-001"),
    pass_group_id: "assistant-zoom-001",
    zoom_id: "zoom-missing-001",
  };
  await assert.rejects(
    service.invoke("zoom.remove", { ...remove, zoom_id: "" }),
    expectCode("invalid_request"),
  );
  await assert.rejects(
    service.invoke("zoom.remove", remove),
    expectCode("edit_conflict"),
  );
  const otherHead = await drafts.snapshot(other.project.project_id);
  await assert.rejects(
    service.invoke("zoom.set", zoomInput(otherHead, "zoom-other-001")),
    expectCode("inactive_project"),
  );
  await assert.rejects(
    service.invoke("speed.set", speedInput(otherHead, "speed-other-001", 2)),
    expectCode("inactive_project"),
  );
  assert.equal((await drafts.snapshot(projectId)).draft.draft_sequence, 0);
  // After one commit, every tool refuses the old head.
  const added = (await service.invoke("zoom.set", {
    ...zoom,
    request_id: "zoom-valid-001",
  })) as ToolCommit;
  await assert.rejects(
    service.invoke("zoom.set", { ...zoom, request_id: "zoom-stale-001" }),
    expectCode("stale_draft"),
  );
  await assert.rejects(
    service.invoke("zoom.remove", {
      ...remove,
      request_id: "zoom-stale-002",
      zoom_id: added.draft.zooms[0]!.zoom_id,
    }),
    expectCode("stale_draft"),
  );
  await assert.rejects(
    service.invoke("speed.set", { ...speed, request_id: "speed-stale-001" }),
    expectCode("stale_draft"),
  );
  // Zooms of one recording cannot overlap.
  await assert.rejects(
    service.invoke(
      "zoom.set",
      zoomInput(await drafts.snapshot(projectId), "zoom-overlap-001"),
    ),
    expectCode("edit_conflict"),
  );
  const current = await drafts.snapshot(projectId);
  assert.equal(current.draft.draft_sequence, 1);
  assert.equal(current.draft.timeline.zooms?.length, 1);
  assert.equal(
    (await drafts.snapshot(other.project.project_id)).draft.draft_sequence,
    0,
  );
});

test("zoom.set refuses a range that spans footage from two recordings", async () => {
  const sha = "a".repeat(64);
  let applied = 0;
  const clip = (id: string, sourceId: string, start: number, end: number) => ({
    clip_id: id,
    track_id: "track-video-001",
    source_id: sourceId,
    source_start_us: 0,
    source_end_us: end - start,
    timeline_start_us: start,
    timeline_end_us: end,
    enabled: true,
  });
  const snapshot = {
    draft: {
      project_id: "project-two-001",
      draft_id: "draft-two-001",
      base_revision_id: "revision-two-001",
      draft_sequence: 3,
      timeline_sha256: sha,
      timeline: {
        clips: [
          clip("clip-a-001", "source-a-001", 0, 1_000_000),
          clip("clip-b-001", "source-b-001", 1_000_000, 2_000_000),
        ],
      },
    },
  };
  const service = new CodexVideoEditToolService("project-two-001", {
    snapshot: async () => snapshot as never,
    snapshotWithProject: async () => {
      throw new Error("unused");
    },
    applyCodex: async () => {
      applied++;
      throw new Error("unused");
    },
    undoCodex: async () => {
      throw new Error("unused");
    },
  });
  const input = {
    schema_version: "1.0",
    request_id: "zoom-two-001",
    project_id: "project-two-001",
    draft_id: "draft-two-001",
    base_revision_id: "revision-two-001",
    expected_sequence: 3,
    expected_timeline_sha256: sha,
    pass_group_id: "assistant-zoom-001",
    reason: "Make the code readable.",
    start_us: 800_000,
    end_us: 1_400_000,
    center_x: 0.5,
    center_y: 0.5,
    scale: 2,
  };
  await assert.rejects(
    service.invoke("zoom.set", input),
    expectCode("invalid_request"),
  );
  // A head that differs from the snapshot is stale before any mapping.
  await assert.rejects(
    service.invoke("zoom.set", { ...input, expected_sequence: 2 }),
    expectCode("stale_draft"),
  );
  // Within one recording the same draft maps and reaches the commit.
  await assert.rejects(
    service.invoke("zoom.set", {
      ...input,
      start_us: 400_000,
      end_us: 1_000_000,
    }),
    expectCode("service_unavailable"),
  );
  assert.equal(applied, 1);
});
