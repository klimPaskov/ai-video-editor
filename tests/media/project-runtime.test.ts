import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import {
  committedDraftView,
  DesktopProjectRuntime,
  invokeWithProjectDraftRefresh,
  type ProjectDraftNotice,
} from "../../apps/desktop/src/project-runtime.ts";
import type { ProjectView } from "../../packages/domain/src/project-view.ts";
import { MediaLibrary } from "../../packages/media-engine/src/library.ts";
import { encodeVerifiedMaster } from "../../packages/media-engine/src/lossless.ts";
import { runProcess } from "../../packages/media-engine/src/process.ts";
import { ProjectStore } from "../../packages/project-store/src/store.ts";
import { DraftTransactionStore } from "../../packages/project-store/src/transactions.ts";

async function fixture() {
  const base = resolve("test-results/project-runtime");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, "fixture-")),
    source = join(root, "source.mkv"),
    videoPath = join(root, "source.bgra"),
    audioPath = join(root, "source.s16le"),
    video = Buffer.alloc(16 * 16 * 4 * 3);
  for (let frame = 0; frame < 3; frame++)
    for (let pixel = 0; pixel < 16 * 16; pixel++) {
      const offset = (frame * 16 * 16 + pixel) * 4;
      video[offset] = 20 + frame * 50;
      video[offset + 1] = 40 + frame * 40;
      video[offset + 2] = 60 + frame * 30;
      video[offset + 3] = 255;
    }
  await writeFile(videoPath, video);
  await writeFile(audioPath, Buffer.alloc(48_000 * 3));
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
    drafts = new DraftTransactionStore(projectsRoot, projects),
    runtime = new DesktopProjectRuntime(drafts, library);
  return { source, library, projects, baseline, drafts, runtime };
}

function frameRequest(project: ProjectView, timelineTimeUs = 0) {
  return {
    projectId: project.id,
    draftId: project.draft.id,
    baseRevisionId: project.draft.baseRevisionId,
    expectedSequence: project.draft.sequence,
    expectedTimelineSha256: project.draft.timelineSha256,
    timelineTimeUs,
  };
}

function trimRequest(
  current: Awaited<ReturnType<DraftTransactionStore["snapshot"]>>,
  requestId: string,
  edge: "start" | "end",
  timelinePositionUs: number,
) {
  return {
    schema_version: "1.0" as const,
    request_id: requestId,
    project_id: current.draft.project_id,
    draft_id: current.draft.draft_id,
    base_revision_id: current.draft.base_revision_id,
    expected_sequence: current.draft.draft_sequence,
    expected_timeline_sha256: current.draft.timeline_sha256,
    pass_group: { pass_group_id: `pass-${requestId}`, kind: "manual" as const },
    reason: "Verify committed project preview mapping.",
    operations: [
      {
        type: "trim" as const,
        clip_id: current.draft.timeline.clips[0]!.clip_id,
        edge,
        timeline_position_us: timelinePositionUs,
      },
    ],
  };
}

function rangeCutRequest(
  current: Awaited<ReturnType<DraftTransactionStore["snapshot"]>>,
  requestId: string,
  startUs: number,
  endUs: number,
) {
  return {
    schema_version: "1.0" as const,
    request_id: requestId,
    project_id: current.draft.project_id,
    draft_id: current.draft.draft_id,
    base_revision_id: current.draft.base_revision_id,
    expected_sequence: current.draft.draft_sequence,
    expected_timeline_sha256: current.draft.timeline_sha256,
    pass_group: { pass_group_id: `pass-${requestId}`, kind: "manual" as const },
    reason: "Verify committed ripple-cut preview mapping.",
    operations: [
      { type: "ripple_delete" as const, start_us: startUs, end_us: endUs },
    ],
  };
}

test("Review draft integrity check returns only a validated committed head", async () => {
  const { source, projects, baseline, drafts, runtime } = await fixture();
  const baselinePath = join(
      baseline.project.storage.project_root,
      "baseline.json",
    ),
    projectPath = join(baseline.project.storage.project_root, "project.json"),
    baselineBytes = await readFile(baselinePath),
    managedBytes = await readFile(baseline.source.managed_path),
    originalBytes = await readFile(source);
  await projects.navigate(baseline.project.project_id, "review");
  const initial = await drafts.snapshotWithProject(baseline.project.project_id),
    initialCheck = await runtime.verifyDraftIntegrity(
      baseline.project.project_id,
    );
  assert.deepEqual(initialCheck.draft, committedDraftView(initial));
  assert.equal(initialCheck.structuralCheckpointRecorded, false);

  await projects.navigate(baseline.project.project_id, "edit");
  await drafts.applyManual(
    trimRequest(
      await drafts.snapshot(baseline.project.project_id),
      "integrity-check-manual-trim",
      "end",
      1_000_000,
    ),
  );
  await projects.navigate(baseline.project.project_id, "review");
  const projectBytes = await readFile(projectPath),
    before = await drafts.snapshotWithProject(baseline.project.project_id),
    checked = await runtime.verifyDraftIntegrity(baseline.project.project_id);
  assert.deepEqual(checked.draft, committedDraftView(before));
  assert.equal(checked.structuralCheckpointRecorded, true);

  const after = await drafts.snapshotWithProject(baseline.project.project_id);
  assert.deepEqual(after.draft, before.draft);
  assert.equal(after.current_pass_checkpoint?.status, "verified");
  assert.deepEqual(after.current_pass_checkpoint?.verified_transaction_ids, [
    after.undo_transaction_id,
  ]);
  assert.ok(
    after.current_pass_checkpoint?.checks.every(
      (check) => check.evidence_ids.length > 0,
    ),
  );
  assert.deepEqual(await readFile(baselinePath), baselineBytes);
  assert.deepEqual(await readFile(projectPath), projectBytes);
  assert.deepEqual(await readFile(baseline.source.managed_path), managedBytes);
  assert.deepEqual(await readFile(source), originalBytes);

  await projects.navigate(baseline.project.project_id, "edit");
  await assert.rejects(
    runtime.verifyDraftIntegrity(baseline.project.project_id),
  );
});

test("committed project views and frames follow trim and undo state without changing source or baseline", async () => {
  const { source, library, projects, baseline, drafts, runtime } =
    await fixture();
  const baselinePath = join(
      baseline.project.storage.project_root,
      "baseline.json",
    ),
    baselineBytes = await readFile(baselinePath),
    sourceBytes = await readFile(source),
    managedBytes = await readFile(baseline.source.managed_path),
    initialView = await runtime.view(baseline.project.project_id),
    expectedOffsetFrame = await library.frame(
      baseline.source.source_id,
      500_000,
    );
  assert.equal(initialView.draft.sequence, 0);
  assert.equal(initialView.timeline.durationUs, 1_500_000);
  assert.deepEqual(initialView.clips, [
    {
      id: baseline.timeline.clips[0]!.clip_id,
      sourceId: baseline.source.source_id,
      timelineStartUs: 0,
      timelineEndUs: 1_500_000,
      sourceStartUs: 0,
      sourceEndUs: 1_500_000,
    },
  ]);

  const initial = await drafts.snapshot(baseline.project.project_id),
    startTrim = await drafts.applyManual(
      trimRequest(initial, "runtime-start-trim-001", "start", 500_000),
    ),
    trimmedView = await runtime.view(baseline.project.project_id);
  assert.equal(trimmedView.draft.sequence, 1);
  assert.equal(trimmedView.timeline.durationUs, 1_000_000);
  assert.equal(trimmedView.clips?.[0]?.sourceStartUs, 500_000);
  assert.equal(trimmedView.clips?.[0]?.timelineEndUs, 1_000_000);
  const trimmedFrame = await runtime.frame(frameRequest(trimmedView));
  assert.equal(trimmedFrame.status, "ready");
  if (trimmedFrame.status !== "ready") throw new Error("Expected frame");
  assert.deepEqual(trimmedFrame.frame, expectedOffsetFrame);

  const endTrim = await drafts.applyManual(
    trimRequest(
      await drafts.snapshot(baseline.project.project_id),
      "runtime-end-trim-001",
      "end",
      500_000,
    ),
  );
  assert.equal(
    (await runtime.view(baseline.project.project_id)).timeline.durationUs,
    500_000,
  );
  await drafts.undoManual({
    schema_version: "1.0",
    request_id: "runtime-undo-001",
    project_id: endTrim.draft.project_id,
    draft_id: endTrim.draft.draft_id,
    base_revision_id: endTrim.draft.base_revision_id,
    expected_sequence: endTrim.draft.draft_sequence,
    expected_timeline_sha256: endTrim.draft.timeline_sha256,
    target_transaction_id: endTrim.transaction.transaction_id,
    reason: "Restore the end trim.",
  });
  const restored = await runtime.view(baseline.project.project_id);
  assert.equal(restored.timeline.durationUs, 1_000_000);
  assert.equal(restored.clips?.[0]?.sourceStartUs, 500_000);
  assert.equal(restored.clips?.[0]?.sourceEndUs, 1_500_000);
  const restoredFrame = await runtime.frame(frameRequest(restored));
  assert.equal(restoredFrame.status, "ready");
  if (restoredFrame.status !== "ready") throw new Error("Expected frame");
  assert.deepEqual(restoredFrame.frame, expectedOffsetFrame);
  assert.equal(startTrim.draft.timeline.clips[0]!.source_start_us, 500_000);
  assert.deepEqual(await readFile(baselinePath), baselineBytes);
  assert.deepEqual(await readFile(source), sourceBytes);
  assert.deepEqual(await readFile(baseline.source.managed_path), managedBytes);
  assert.equal(
    (await projects.open(baseline.project.project_id)).timeline.duration_us,
    1_500_000,
  );
});

test("preview maps every committed fragment through its own source interval", async () => {
  const { baseline, drafts } = await fixture();
  const committed = structuredClone(
    await drafts.snapshotWithProject(baseline.project.project_id),
  );
  const original = committed.draft.timeline.clips[0]!;
  committed.draft.timeline.clips = [
    {
      ...original,
      clip_id: "clip-first",
      source_start_us: 0,
      source_end_us: 300_000,
      timeline_start_us: 0,
      timeline_end_us: 300_000,
    },
    {
      ...original,
      clip_id: "clip-middle",
      source_start_us: 400_000,
      source_end_us: 700_000,
      timeline_start_us: 300_000,
      timeline_end_us: 600_000,
    },
    {
      ...original,
      clip_id: "clip-last",
      source_start_us: 900_000,
      source_end_us: 1_500_000,
      timeline_start_us: 600_000,
      timeline_end_us: 1_200_000,
    },
  ];
  committed.draft.timeline.duration_us = 1_200_000;
  committed.draft.timeline_sha256 = "b".repeat(64);
  committed.draft.draft_sequence = 1;
  const requested: number[] = [];
  const runtime = new DesktopProjectRuntime(
    {
      snapshotWithProject: async () => structuredClone(committed),
      recordLatestManualStructureCheckpoint: async () => null,
    },
    {
      frame: async (_id, sourceTimeUs) => {
        requested.push(sourceTimeUs);
        return { width: 1, height: 1, rgbaBase64: "AAAAAA==" };
      },
    },
  );
  const project = await runtime.view(baseline.project.project_id);
  assert.equal(project.clips?.length, 3);
  assert.deepEqual(
    project.clips?.map((clip) => clip.id),
    ["clip-first", "clip-middle", "clip-last"],
  );
  for (const timeUs of [299_999, 300_000, 599_999, 600_000, 1_199_999]) {
    const result = await runtime.frame(frameRequest(project, timeUs));
    assert.equal(result.status, "ready");
  }
  assert.deepEqual(requested, [299_999, 400_000, 699_999, 900_000, 1_499_999]);
});

test("ripple cut preview maps surviving fragments and keeps both immutable source summaries", async () => {
  const { source, library, projects, baseline, drafts } = await fixture();
  const secondVideoPath = join(dirname(source), "second.bgra");
  const secondAudioPath = join(dirname(source), "second.s16le");
  const secondSourcePath = join(dirname(source), "second.mkv");
  const pixels = Buffer.alloc(16 * 16 * 4 * 3);
  for (let offset = 0; offset < pixels.length; offset += 4) {
    pixels[offset] = 205;
    pixels[offset + 1] = 65;
    pixels[offset + 2] = 25;
    pixels[offset + 3] = 255;
  }
  await writeFile(secondVideoPath, pixels);
  await writeFile(secondAudioPath, Buffer.alloc(48_000 * 3));
  await encodeVerifiedMaster(
    {
      videoPath: secondVideoPath,
      audioPath: secondAudioPath,
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
    secondSourcePath,
  );
  const second = await library.importFile(secondSourcePath);
  const joined = await projects.createFromTwoMedia(
    baseline.source.source_id,
    second.id,
  );
  const projectId = joined.project.project_id;
  const runtime = new DesktopProjectRuntime(drafts, library);
  const original = await runtime.view(projectId);
  assert.equal(original.timeline.durationUs, 3_000_000);

  const cut = await drafts.applyManual(
    rangeCutRequest(
      await drafts.snapshot(projectId),
      "runtime-ripple-001",
      750_000,
      2_250_000,
    ),
  );
  const edited = await runtime.view(projectId);
  assert.equal(edited.timeline.durationUs, 1_500_000);
  assert.equal(edited.draft.sequence, 1);
  assert.deepEqual(
    edited.sources?.map((item) => item.id),
    [joined.sources[0]!.source_id, second.id],
  );
  assert.deepEqual(
    edited.clips?.map((clip) => [
      clip.sourceId,
      clip.timelineStartUs,
      clip.timelineEndUs,
      clip.sourceStartUs,
      clip.sourceEndUs,
    ]),
    [
      [joined.sources[0]!.source_id, 0, 750_000, 0, 750_000],
      [second.id, 750_000, 1_500_000, 750_000, 1_500_000],
    ],
  );
  const beforeJoin = await runtime.frame(frameRequest(edited, 749_999));
  const atJoin = await runtime.frame(frameRequest(edited, 750_000));
  assert.equal(beforeJoin.status, "ready");
  assert.equal(atJoin.status, "ready");
  if (beforeJoin.status !== "ready" || atJoin.status !== "ready") return;
  assert.deepEqual(
    beforeJoin.frame,
    await library.frame(joined.sources[0]!.source_id, 749_999),
  );
  assert.deepEqual(atJoin.frame, await library.frame(second.id, 750_000));

  await drafts.applyManual(
    rangeCutRequest(
      await drafts.snapshot(projectId),
      "runtime-ripple-002",
      0,
      750_000,
    ),
  );
  const secondOnly = await runtime.view(projectId);
  assert.equal(secondOnly.clips?.length, 1);
  assert.equal(secondOnly.clips?.[0]?.sourceId, second.id);
  assert.deepEqual(
    secondOnly.sources?.map((item) => item.id),
    [joined.sources[0]!.source_id, second.id],
  );
  const secondOnlyFrame = await runtime.frame(frameRequest(secondOnly, 0));
  assert.equal(secondOnlyFrame.status, "ready");
  if (secondOnlyFrame.status === "ready")
    assert.deepEqual(
      secondOnlyFrame.frame,
      await library.frame(second.id, 750_000),
    );
  assert.equal(cut.draft.timeline.duration_us, 1_500_000);
});

test("tagged H.264 project frames follow the committed trim without using display pixels as source", async () => {
  const base = resolve("test-results/project-runtime");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, "h264-"));
  const source = join(root, "source.mp4");
  await runProcess({
    executable: "ffmpeg",
    args: [
      "-v",
      "error",
      "-nostdin",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=64x48:rate=2:duration=1.5",
      "-vf",
      "setparams=range=tv:color_primaries=bt709:color_trc=bt709:colorspace=bt709",
      "-c:v",
      "libx264",
      "-qp",
      "0",
      "-pix_fmt",
      "yuv420p",
      "-color_range",
      "tv",
      "-colorspace",
      "bt709",
      "-color_primaries",
      "bt709",
      "-color_trc",
      "bt709",
      source,
    ],
  });
  const original = await readFile(source);
  const library = new MediaLibrary(join(root, "library"));
  const media = await library.importFile(source);
  const projects = new ProjectStore(join(root, "projects"), library);
  const baseline = await projects.createFromMedia(media.id);
  const baselineBytes = await readFile(
    join(baseline.project.storage.project_root, "baseline.json"),
  );
  const drafts = new DraftTransactionStore(join(root, "projects"), projects);
  const runtime = new DesktopProjectRuntime(drafts, library);
  const initialView = await runtime.view(baseline.project.project_id);
  assert.equal(initialView.timeline.durationUs, 1_500_000);
  const initialFrame = await runtime.frame(frameRequest(initialView, 500_000));
  assert.equal(initialFrame.status, "ready");
  if (initialFrame.status !== "ready")
    throw new Error("Expected initial frame");
  const committed = await drafts.applyManual(
    trimRequest(
      await drafts.snapshot(baseline.project.project_id),
      "h264-trim-001",
      "start",
      500_000,
    ),
  );
  const stale = await runtime.frame(frameRequest(initialView, 0));
  assert.equal(stale.status, "stale");
  assert.equal("frame" in stale, false);
  const trimmedView = await runtime.view(baseline.project.project_id);
  const trimmedFrame = await runtime.frame(frameRequest(trimmedView, 0));
  assert.equal(trimmedFrame.status, "ready");
  if (trimmedFrame.status !== "ready")
    throw new Error("Expected trimmed frame");
  assert.deepEqual(trimmedFrame.frame, initialFrame.frame);
  assert.equal(committed.draft.timeline.clips[0]!.source_start_us, 500_000);
  assert.deepEqual(await readFile(source), original);
  assert.deepEqual(await readFile(baseline.source.managed_path), original);
  assert.deepEqual(
    await readFile(
      join(baseline.project.storage.project_root, "baseline.json"),
    ),
    baselineBytes,
  );
});

test("stale heads return authoritative state and never expose stale decoded pixels", async () => {
  const { baseline, drafts } = await fixture();
  let decodeCalls = 0;
  let releaseDecode: (() => void) | undefined;
  const decodeStarted = Promise.withResolvers<void>();
  const runtime = new DesktopProjectRuntime(drafts, {
    frame: async () => {
      decodeCalls += 1;
      decodeStarted.resolve();
      await new Promise<void>((resolveDecode) => {
        releaseDecode = resolveDecode;
      });
      return { width: 1, height: 1, rgbaBase64: "AAAAAA==" };
    },
  });
  const initialView = await runtime.view(baseline.project.project_id),
    initial = await drafts.snapshot(baseline.project.project_id);
  await drafts.applyManual(
    trimRequest(initial, "runtime-stale-before-001", "start", 500_000),
  );
  const staleBefore = await runtime.frame(frameRequest(initialView));
  assert.equal(staleBefore.status, "stale");
  assert.equal(decodeCalls, 0);

  const currentView = await runtime.view(baseline.project.project_id),
    pending = runtime.frame(frameRequest(currentView));
  await decodeStarted.promise;
  await drafts.applyManual(
    trimRequest(
      await drafts.snapshot(baseline.project.project_id),
      "runtime-stale-after-001",
      "end",
      500_000,
    ),
  );
  releaseDecode?.();
  const staleAfter = await pending;
  assert.equal(staleAfter.status, "stale");
  assert.equal("frame" in staleAfter, false);
  assert.equal(decodeCalls, 1);
});

test("atomic project snapshots are detached and serialize navigation with draft commits", async () => {
  const { baseline, projects, drafts } = await fixture();
  const initial = await drafts.snapshot(baseline.project.project_id),
    [navigated, committed] = await Promise.all([
      projects.navigate(baseline.project.project_id, "edit"),
      drafts.applyManual(
        trimRequest(initial, "runtime-serialized-001", "start", 500_000),
      ),
    ]);
  assert.equal(navigated.project.workflow_step, "edit");
  assert.equal(committed.draft.draft_sequence, 1);
  const atomic = await drafts.snapshotWithProject(baseline.project.project_id);
  assert.equal(atomic.project.project.workflow_step, "edit");
  assert.equal(atomic.draft.draft_sequence, 1);
  atomic.project.project.name = "mutated copy";
  atomic.draft.timeline.duration_us = 1;
  const reopened = await drafts.snapshotWithProject(
    baseline.project.project_id,
  );
  assert.notEqual(reopened.project.project.name, "mutated copy");
  assert.equal(reopened.draft.timeline.duration_us, 1_000_000);
});

test("settled mutations refresh after an uncertain committed outcome without replacing tool results", async () => {
  const { baseline, drafts } = await fixture();
  const projectId = baseline.project.project_id,
    initial = await drafts.snapshot(projectId),
    notices: ProjectDraftNotice[] = [],
    uncertain = new Error("response lost after journal rename");
  await assert.rejects(
    invokeWithProjectDraftRefresh({
      toolName: "cut.trim_edge",
      projectId,
      activeProjectId: () => projectId,
      work: async () => {
        await drafts.applyManual(
          trimRequest(initial, "runtime-uncertain-001", "start", 500_000),
        );
        throw uncertain;
      },
      drafts,
      notify: (notice) => notices.push(notice),
    }),
    (error) => error === uncertain,
  );
  assert.equal(notices.length, 1);
  assert.equal(notices[0]?.ok, true);
  if (!notices[0]?.ok) throw new Error("Expected committed refresh");
  assert.equal(notices[0].value.draft.sequence, 1);
  assert.equal(notices[0].value.timeline.durationUs, 1_000_000);
  assert.equal(notices[0].value.clips?.[0]?.sourceStartUs, 500_000);

  assert.equal(
    await invokeWithProjectDraftRefresh({
      toolName: "timeline.undo",
      projectId,
      activeProjectId: () => projectId,
      work: async () => "tool-result",
      drafts,
      notify: () => {
        throw new Error("window closed");
      },
    }),
    "tool-result",
  );
});
test("rejected manual edits publish the current committed clip map without claiming success", async () => {
  const { baseline, drafts } = await fixture();
  const projectId = baseline.project.project_id;
  const initial = await drafts.snapshot(projectId);
  await drafts.applyManual(
    trimRequest(initial, "manual-fresh-001", "start", 500_000),
  );
  const notices: ProjectDraftNotice[] = [];
  for (const bad of [
    trimRequest(initial, "manual-stale-001", "end", 500_000),
    trimRequest(
      await drafts.snapshot(projectId),
      "manual-invalid-001",
      "end",
      0,
    ),
  ]) {
    await assert.rejects(
      invokeWithProjectDraftRefresh({
        toolName: "cut.trim_edge",
        projectId,
        activeProjectId: () => projectId,
        work: () => drafts.applyManual(bad),
        drafts,
        notify: (notice) => notices.push(notice),
      }),
    );
  }
  assert.equal(notices.length, 2);
  for (const notice of notices) {
    assert.equal(notice.ok, true);
    if (!notice.ok) continue;
    assert.equal(notice.value.draft.sequence, 1);
    assert.equal(notice.value.clips?.[0]?.sourceStartUs, 500_000);
  }
});

test("split tool outcomes publish an authoritative committed fragment map", async () => {
  const { baseline, drafts } = await fixture();
  const notices: ProjectDraftNotice[] = [];
  for (const toolName of ["timeline.split", "cut.split"]) {
    const result = await invokeWithProjectDraftRefresh({
      toolName,
      projectId: baseline.project.project_id,
      activeProjectId: () => baseline.project.project_id,
      work: async () => "split-result",
      drafts,
      notify: (notice) => notices.push(notice),
    });
    assert.equal(result, "split-result");
  }
  assert.equal(notices.length, 2);
  for (const notice of notices) {
    assert.equal(notice.ok, true);
    if (notice.ok) assert.equal(notice.value.clips?.length, 1);
  }
});

test("ripple-delete tool outcomes publish the surviving committed map after an uncertain reply", async () => {
  const { baseline, drafts } = await fixture();
  const projectId = baseline.project.project_id;
  const notices: ProjectDraftNotice[] = [];
  const uncertain = new Error("reply lost after committed cut");
  await assert.rejects(
    invokeWithProjectDraftRefresh({
      toolName: "timeline.ripple_delete",
      projectId,
      activeProjectId: () => projectId,
      work: async () => {
        await drafts.applyManual(
          rangeCutRequest(
            await drafts.snapshot(projectId),
            "runtime-refresh-cut-001",
            500_000,
            1_000_000,
          ),
        );
        throw uncertain;
      },
      drafts,
      notify: (notice) => notices.push(notice),
    }),
    (error) => error === uncertain,
  );
  assert.equal(notices.length, 1);
  assert.equal(notices[0]?.ok, true);
  if (!notices[0]?.ok) return;
  assert.equal(notices[0].value.draft.sequence, 1);
  assert.equal(notices[0].value.timeline.durationUs, 1_000_000);
  assert.deepEqual(
    notices[0].value.clips?.map((clip) => [
      clip.timelineStartUs,
      clip.timelineEndUs,
      clip.sourceStartUs,
      clip.sourceEndUs,
    ]),
    [
      [0, 500_000, 0, 500_000],
      [500_000, 1_000_000, 1_000_000, 1_500_000],
    ],
  );
});

test("Codex range-cut outcomes refresh the authoritative draft after an uncertain reply", async () => {
  const { baseline, drafts } = await fixture();
  const projectId = baseline.project.project_id;
  const notices: ProjectDraftNotice[] = [];
  await assert.rejects(
    invokeWithProjectDraftRefresh({
      toolName: "cut.delete_range",
      projectId,
      activeProjectId: () => projectId,
      work: async () => {
        await drafts.applyManual(
          rangeCutRequest(
            await drafts.snapshot(projectId),
            "codex-refresh-cut-001",
            500_000,
            1_000_000,
          ),
        );
        throw new Error("reply lost");
      },
      drafts,
      notify: (notice) => notices.push(notice),
    }),
    /reply lost/,
  );
  assert.equal(notices.length, 1);
  assert.equal(notices[0]?.ok, true);
  if (!notices[0]?.ok) return;
  assert.equal(notices[0].value.draft.sequence, 1);
  assert.equal(notices[0].value.timeline.durationUs, 1_000_000);
  assert.equal(notices[0].value.clips?.length, 2);
});
