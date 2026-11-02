import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  assertInitialProjectSnapshot,
  assertTwoSourceInitialProjectSnapshot,
  createInitialProject,
  createTwoSourceInitialProject,
  projectCanonicalJson,
  projectStages,
  timelineSha256,
} from "../../packages/domain/src/project.ts";
import type {
  InitialProjectInput,
  InitialProjectSnapshot,
  TwoSourceInitialProjectInput,
  TwoSourceInitialProjectSnapshot,
} from "../../packages/domain/src/project.ts";

function input(): InitialProjectInput {
  return {
    projectId: "project-fixture",
    timelineId: "timeline-fixture",
    revisionId: "revision-fixture",
    sourceId: "source-fixture",
    name: "Synthetic source",
    createdAt: "2026-09-06T10:00:00Z",
    projectRoot: "/synthetic/project",
    originalPath: "/synthetic/original.mkv",
    managedPath: "/synthetic/library/source.media",
    sha256: "a".repeat(64),
    sizeBytes: 12000,
    probe: {
      streams: [
        {
          index: 0,
          codec_type: "video",
          codec_name: "ffv1",
          width: 3840,
          height: 2160,
          avg_frame_rate: "60000/2002",
          duration: "1.001000",
          nb_frames: "30",
          pix_fmt: "gbrp16le",
          bits_per_raw_sample: "16",
          color_range: "pc",
          color_space: "gbr",
          color_primaries: "bt2020",
          color_transfer: "smpte2084",
          side_data_list: [
            {
              side_data_type: "Mastering display metadata",
              max_luminance: "1000/1",
            },
          ],
        },
        {
          index: 1,
          codec_type: "audio",
          codec_name: "pcm_f64le",
          sample_fmt: "dbl",
          sample_rate: "96000",
          channels: 6,
          channel_layout: "5.1",
          bits_per_sample: 64,
        },
      ],
      format: { duration: "1.001000", format_name: "matroska,webm" },
    },
  };
}

function twoSourceInput(): TwoSourceInitialProjectInput {
  const first = input();
  const secondProbe = structuredClone(first.probe);
  const firstVideo = (first.probe.streams as Record<string, unknown>[])[0]!;
  const secondVideo = (secondProbe.streams as Record<string, unknown>[])[0]!;
  firstVideo.r_frame_rate = "30000/1001";
  firstVideo.time_base = "1/1000";
  firstVideo.start_pts = 0;
  firstVideo.sample_aspect_ratio = "1:1";
  secondVideo.r_frame_rate = "30000/1001";
  secondVideo.time_base = "1/1000";
  secondVideo.start_pts = 0;
  secondVideo.sample_aspect_ratio = "1:1";
  secondVideo.avg_frame_rate = "30000/1000";
  secondVideo.duration = "1.003000";
  (secondProbe.format as Record<string, unknown>).duration = "1.003000";
  return {
    projectId: first.projectId,
    timelineId: first.timelineId,
    revisionId: first.revisionId,
    name: "Ordered synthetic sources",
    createdAt: first.createdAt,
    projectRoot: first.projectRoot,
    sources: [
      {
        sourceId: first.sourceId,
        originalPath: first.originalPath,
        managedPath: first.managedPath,
        sha256: first.sha256,
        sizeBytes: first.sizeBytes,
        probe: first.probe,
        timing: {
          timeBaseNumerator: 1,
          timeBaseDenominator: 1000,
          firstPts: 0,
          lastPts: 968,
          lastDurationTicks: 33,
          frameCount: 30,
          presentationEndUs: 1_001_000,
        },
      },
      {
        sourceId: "source-following",
        originalPath: "/synthetic/original-following.mkv",
        managedPath: "/synthetic/library/source-following.media",
        sha256: "b".repeat(64),
        sizeBytes: 14000,
        probe: secondProbe,
        timing: {
          timeBaseNumerator: 1,
          timeBaseDenominator: 1000,
          firstPts: 0,
          lastPts: 970,
          lastDurationTicks: 33,
          frameCount: 30,
          presentationEndUs: 1_003_000,
        },
      },
    ],
  };
}

test("two-source baseline keeps ordered VFR probes and adjacent half-open clips", () => {
  const original = twoSourceInput();
  const snapshot = createTwoSourceInitialProject(original);
  assertTwoSourceInitialProjectSnapshot(snapshot);
  assert.equal(snapshot.schema_version, "1.1");
  assert.deepEqual(snapshot.project.source_ids, [
    "source-fixture",
    "source-following",
  ]);
  assert.equal(snapshot.sources[0].duration_us, 1_001_000);
  assert.equal(snapshot.sources[1].duration_us, 1_003_000);
  assert.equal(snapshot.timeline.duration_us, 2_004_000);
  assert.deepEqual(snapshot.timeline.frame_rate, {
    numerator: 30000,
    denominator: 1001,
  });
  assert.notDeepEqual(
    snapshot.sources[0].streams[0]?.frame_rate,
    snapshot.sources[1].streams[0]?.frame_rate,
  );
  assert.deepEqual(
    snapshot.timeline.clips.map((clip) => [
      clip.source_id,
      clip.source_start_us,
      clip.source_end_us,
      clip.timeline_start_us,
      clip.timeline_end_us,
    ]),
    [
      ["source-fixture", 0, 1_001_000, 0, 1_001_000],
      ["source-following", 0, 1_003_000, 1_001_000, 2_004_000],
    ],
  );
  assert.equal(
    snapshot.revision.timeline_sha256,
    timelineSha256(snapshot.timeline),
  );
  assert.deepEqual(
    snapshot.source_probes,
    original.sources.map((source) => source.probe),
  );
  original.sources[0].probe.bad = "later mutation";
  assert.equal("bad" in snapshot.source_probes[0], false);
  const check = spawnSync(
    "python",
    [
      "-c",
      "import json,sys; from pathlib import Path; from jsonschema import Draft202012Validator; d=json.load(sys.stdin); s=Path('docs/schemas'); [(Draft202012Validator(json.loads((s/(k+'.schema.json')).read_text(encoding='utf-8'))).validate(v)) for k,v in [('project',d['project']),('timeline',d['timeline']),('revision',d['revision']),*[(\"source\",x) for x in d['sources']]]]",
    ],
    { input: JSON.stringify(snapshot), encoding: "utf8" },
  );
  assert.equal(check.status, 0, check.stderr);
});

test("two-source baseline includes a measured final frame beyond rounded stream duration", () => {
  const value = twoSourceInput();
  const second = value.sources[1];
  const video = (second.probe.streams as Record<string, unknown>[])[0]!;
  video.duration = "0.990000";
  const snapshot = createTwoSourceInitialProject(value);
  assertTwoSourceInitialProjectSnapshot(snapshot);
  assert.equal(snapshot.sources[1].duration_us, 1_003_000);
  assert.equal(snapshot.timeline.clips[1]?.timeline_start_us, 1_001_000);
  assert.equal(snapshot.timeline.clips[1]?.timeline_end_us, 2_004_000);
});

test("two-source navigation changes only the persisted stage and update time", () => {
  const snapshot = createTwoSourceInitialProject(twoSourceInput());
  const baselineHash = snapshot.revision.timeline_sha256;
  for (const stage of projectStages) {
    snapshot.project.workflow_step = stage;
    snapshot.project.updated_at = "2026-09-06T10:01:00Z";
    assertTwoSourceInitialProjectSnapshot(snapshot);
    assert.equal(snapshot.revision.timeline_sha256, baselineHash);
  }
});

test("two-source baseline rejects forged timing, mixed formats and reordered references", () => {
  const mutateInput: ((value: TwoSourceInitialProjectInput) => void)[] = [
    (v) => {
      v.sources[1].sourceId = v.sources[0].sourceId;
    },
    (v) => {
      v.sources[1].timing.presentationEndUs++;
    },
    (v) => {
      v.sources[1].timing.frameCount--;
    },
    (v) => {
      v.sources[1].timing.timeBaseDenominator = 90000;
    },
    (v) => {
      v.sources[1].timing.firstPts = 1;
    },
    (v) => {
      v.sources[1].timing.lastDurationTicks = 0;
    },
    (v) => {
      (v.sources[1].probe.streams as Record<string, unknown>[])[0]!.duration =
        "2.000000";
    },
    (v) => {
      (v.sources[1].probe.streams as Record<string, unknown>[])[0]!.width =
        1920;
    },
    (v) => {
      (v.sources[1].probe.streams as Record<string, unknown>[])[0]!.pix_fmt =
        "yuv420p";
    },
    (v) => {
      (
        v.sources[1].probe.streams as Record<string, unknown>[]
      )[0]!.color_range = "tv";
    },
    (v) => {
      (
        v.sources[1].probe.streams as Record<string, unknown>[]
      )[0]!.r_frame_rate = "30/1";
    },
    (v) => {
      (
        v.sources[1].probe.streams as Record<string, unknown>[]
      )[1]!.sample_rate = "48000";
    },
    (v) => {
      (v.sources[1].probe.streams as Record<string, unknown>[])[1]!.sample_fmt =
        "flt";
    },
    (v) => {
      (v.sources[1].probe.streams as Record<string, unknown>[]).pop();
    },
  ];
  for (const mutate of mutateInput) {
    const value = twoSourceInput();
    mutate(value);
    assert.throws(() => createTwoSourceInitialProject(value));
  }
  const mutateSnapshot: ((value: TwoSourceInitialProjectSnapshot) => void)[] = [
    (s) => {
      s.sources.reverse();
    },
    (s) => {
      s.timeline.clips[1]!.timeline_start_us--;
    },
    (s) => {
      s.timeline.clips[0]!.source_end_us--;
    },
    (s) => {
      s.source_timings[0].lastPts--;
    },
    (s) => {
      s.sources[0].immutable = false as true;
    },
    (s) => {
      s.project.source_ids.reverse();
    },
  ];
  for (const mutate of mutateSnapshot) {
    const snapshot = createTwoSourceInitialProject(twoSourceInput());
    mutate(snapshot);
    assert.throws(() => assertTwoSourceInitialProjectSnapshot(snapshot));
  }
});
test("initial project creates actual consistent source/timeline/revision contracts without format conversion", () => {
  const original = input();
  const snapshot = createInitialProject(original);
  assertInitialProjectSnapshot(snapshot);
  assert.deepEqual(snapshot.timeline.frame_rate, {
    numerator: 30000,
    denominator: 1001,
  });
  assert.equal(snapshot.timeline.duration_us, 1001000);
  assert.deepEqual(snapshot.timeline.canvas, {
    width: 3840,
    height: 2160,
    aspect_ratio: "custom",
  });
  assert.equal(
    snapshot.revision.timeline_sha256,
    timelineSha256(snapshot.timeline),
  );
  assert.deepEqual(snapshot.source_probe, original.probe);
  assert.equal(snapshot.source.streams[1]?.sample_rate_hz, 96000);
  assert.equal(snapshot.source.streams[1]?.channels, 6);
  assert.deepEqual(snapshot.timeline.operation_ids, []);
  assert.equal(snapshot.revision.qa_status, "not_run");
  original.probe.format = { duration: "999" };
  assert.notDeepEqual(snapshot.source_probe, original.probe);
  // Existing published schemas remain authoritative; no fields were added to these records.
  const check = spawnSync(
    "python",
    [
      "-c",
      "import json,sys; from pathlib import Path; from jsonschema import Draft202012Validator; d=json.load(sys.stdin); [(Draft202012Validator(json.loads(Path('docs/schemas/'+k+'.schema.json').read_text(encoding='utf-8'))).validate(d[k])) for k in ('project','source','timeline','revision')]",
    ],
    { input: JSON.stringify(snapshot), encoding: "utf8" },
  );
  assert.equal(check.status, 0, check.stderr);
});
test("persisted navigation preserves baseline hashes and allows only the six actual stages", () => {
  const snapshot = createInitialProject(input());
  const hash = snapshot.revision.timeline_sha256;
  for (const stage of projectStages) {
    snapshot.project.workflow_step = stage;
    snapshot.project.updated_at = "2026-09-06T10:01:00Z";
    assertInitialProjectSnapshot(snapshot);
    assert.equal(snapshot.revision.timeline_sha256, hash);
  }
  assert.equal(
    projectCanonicalJson({ b: 2, a: 1 }),
    projectCanonicalJson({ a: 1, b: 2 }),
  );
});

test("container duration fallback preserves measured rational rate without inventing frame counts", () => {
  const value = input();
  const video = (value.probe.streams as Record<string, unknown>[])[0]!;
  delete video.duration;
  delete video.nb_frames;
  const snapshot = createInitialProject(value);
  assertInitialProjectSnapshot(snapshot);
  assert.equal(snapshot.timeline.duration_us, 1001000);
  assert.deepEqual(snapshot.timeline.frame_rate, {
    numerator: 30000,
    denominator: 1001,
  });
  assert.equal(
    "nb_frames" in
      (snapshot.source_probe.streams as Record<string, unknown>[])[0]!,
    false,
  );
});
test("bad references, hashes, ranges, fabricated edits and malformed baseline records fail", () => {
  const mutations: ((snapshot: InitialProjectSnapshot) => void)[] = [
    (s) => {
      s.project.current_revision_id = "other-revision";
    },
    (s) => {
      s.project.source_ids = ["other-source"];
    },
    (s) => {
      s.timeline.project_id = "other-project";
    },
    (s) => {
      s.timeline.revision_id = "other-revision";
    },
    (s) => {
      s.timeline.clips[0]!.source_id = "other-source";
    },
    (s) => {
      s.timeline.clips[0]!.track_id = "other-track";
    },
    (s) => {
      s.timeline.clips[0]!.source_start_us = 1;
    },
    (s) => {
      s.timeline.clips[0]!.timeline_end_us++;
    },
    (s) => {
      s.timeline.duration_us++;
      s.revision.timeline_sha256 = timelineSha256(s.timeline);
    },
    (s) => {
      s.source.duration_us++;
    },
    (s) => {
      s.timeline.frame_rate.denominator = 1000;
    },
    (s) => {
      s.timeline.canvas.width = 1920;
    },
    (s) => {
      s.revision.timeline_sha256 = "0".repeat(64);
    },
    (s) => {
      s.timeline.operation_ids.push("fake-operation");
    },
    (s) => {
      s.project.updated_at = "2026-09-05T10:01:00Z";
    },
    (s) => {
      Object.assign(s.project, { workflow_step: "complete" });
    },
    (s) => {
      Object.assign(s.revision, { locked: false });
    },
    (s) => {
      Object.assign(s.source, { immutable: false });
    },
    (s) => {
      Object.assign(s, { unexpected: true });
    },
    (s) => {
      s.source.streams[0]!.width = NaN;
    },
  ];
  for (const mutate of mutations) {
    const snapshot = createInitialProject(input());
    mutate(snapshot);
    assert.throws(() => assertInitialProjectSnapshot(snapshot));
  }
  for (const value of [null, [], {}, { project: {} }])
    assert.throws(() => assertInitialProjectSnapshot(value));
});
test("real probe timing and stream metadata are required; unsupported or contradictory values fail", () => {
  const mutations: ((value: InitialProjectInput) => void)[] = [
    (value) => {
      value.createdAt = "2026-02-30T10:00:00Z";
    },
    (value) => {
      value.projectRoot = "relative";
    },
    (value) => {
      value.sizeBytes = Infinity;
    },
    (value) => {
      value.sourceId = value.projectId;
    },
    (value) => {
      value.sha256 = "unknown";
    },
    (value) => {
      (value.probe.streams as Record<string, unknown>[])[0]!.avg_frame_rate =
        "29.97";
    },
    (value) => {
      (value.probe.streams as Record<string, unknown>[])[0]!.avg_frame_rate =
        "0/0";
    },
    (value) => {
      (value.probe.streams as Record<string, unknown>[])[0]!.duration = "NaN";
    },
    (value) => {
      (value.probe.streams as Record<string, unknown>[])[0]!.duration = "0";
    },
    (value) => {
      (value.probe.streams as Record<string, unknown>[])[0]!.nb_frames = "90";
    },
    (value) => {
      (value.probe.streams as Record<string, unknown>[])[0]!.width = -1;
    },
    (value) => {
      (value.probe.streams as Record<string, unknown>[])[1]!.index = 0;
    },
    (value) => {
      (value.probe.streams as Record<string, unknown>[])[1]!.channels = NaN;
    },
    (value) => {
      (value.probe.streams as Record<string, unknown>[])[1]!.codec_type =
        "attachment";
    },
    (value) => {
      value.probe.bad = undefined;
    },
  ];
  for (const mutate of mutations) {
    const value = input();
    mutate(value);
    assert.throws(() => createInitialProject(value));
  }
  for (const value of [
    NaN,
    Infinity,
    undefined,
    { value: undefined },
    [undefined],
  ])
    assert.throws(() => projectCanonicalJson(value));
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  assert.throws(() => projectCanonicalJson(cycle));
});
