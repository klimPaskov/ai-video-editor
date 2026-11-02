import assert from "node:assert/strict";
import test from "node:test";
import {
  assertSoundAddRequest,
  assertSoundRemoveRequest,
  assertSoundUpdateRequest,
  assertSoundsRequest,
  assertSoundsView,
} from "../../packages/domain/src/sound-view.ts";
import {
  buildSoundLayer,
  SoundBuildError,
  type SoundAsset,
} from "../../packages/domain/src/sounds.ts";

const head = { schema_version: "1.0", project_id: "project-1" };
const asset: SoundAsset = {
  asset_id: "asset-1",
  name: "Theme",
  sha256: "b".repeat(64),
  duration_us: 30_000_000,
  sample_rate: 44_100,
  channels: 2,
  size_bytes: 1000,
};
const timeline = {
  duration_us: 20_000_000,
  clips: [
    {
      source_id: "source-1",
      source_start_us: 5_000_000,
      source_end_us: 25_000_000,
      timeline_start_us: 0,
      timeline_end_us: 20_000_000,
    },
  ],
};
const ids = () => "sound-fixed";

test("sound IPC requests accept exactly their fields", () => {
  assertSoundsRequest(head);
  assertSoundAddRequest({ ...head, kind: "music", start_us: 0 });
  assertSoundUpdateRequest({
    ...head,
    sound_id: "sound-1",
    gain_db: -12,
    duck_db: 0,
  });
  assertSoundRemoveRequest({ ...head, sound_id: "sound-1" });
  const refused: [(value: unknown) => void, unknown][] = [
    [assertSoundsRequest, { ...head, path: "/x" }],
    [assertSoundsRequest, { schema_version: "1.0", project_id: "../x" }],
    [assertSoundAddRequest, { ...head, kind: "ambience", start_us: 0 }],
    [assertSoundAddRequest, { ...head, kind: "music", start_us: -1 }],
    [assertSoundAddRequest, { ...head, kind: "music", start_us: 1.5 }],
    [
      assertSoundAddRequest,
      { ...head, kind: "music", start_us: 0, path: "/m.mp3" },
    ],
    [
      assertSoundUpdateRequest,
      { ...head, sound_id: "sound-1", gain_db: 13, duck_db: 0 },
    ],
    [
      assertSoundUpdateRequest,
      { ...head, sound_id: "sound-1", gain_db: -6, duck_db: 31 },
    ],
    [assertSoundRemoveRequest, { ...head, sound_id: "x" }],
  ];
  for (const [check, value] of refused)
    assert.throws(() => check(value), /Invalid sound exchange/u);
});

test("the sounds view is checked field by field", () => {
  const layer = {
    sound_id: "sound-1",
    name: "Theme",
    kind: "music",
    file_name: "theme",
    asset_id: "asset-1",
    asset_start_us: 0,
    fade_in_us: 1_000_000,
    fade_out_us: 2_000_000,
    gain_db: -18,
    duck_db: 12,
    loop: true,
    timeline_range: { start_us: 0, end_us: 9_000_000 },
  };
  assertSoundsView({ ...head, layers: [layer] });
  assertSoundsView({ ...head, layers: [{ ...layer, timeline_range: null }] });
  for (const bad of [
    { ...layer, extra: 1 },
    { ...layer, gain_db: -6.5 },
    { ...layer, kind: "ambience" },
    { ...layer, timeline_range: { start_us: 5, end_us: 5 } },
    { ...layer, asset_id: "../x" },
  ])
    assert.throws(
      () => assertSoundsView({ ...head, layers: [bad] }),
      /Invalid sound exchange/u,
    );
});

test("music defaults to a ducked bed from the start; effects follow cuts", () => {
  const bed = buildSoundLayer(
    { name: " Theme ", kind: "music", asset, startUs: 0 },
    timeline,
    ids,
  );
  assert.deepEqual(bed, {
    sound_id: "sound-fixed",
    name: "Theme",
    kind: "music",
    asset_id: "asset-1",
    asset_sha256: "b".repeat(64),
    asset_start_us: 0,
    duration_us: 20_000_000,
    start: { type: "output", start_us: 0 },
    gain_db: -18,
    fade_in_us: 1_000_000,
    fade_out_us: 2_000_000,
    duck_db: 12,
    loop: true,
  });
  const hit = buildSoundLayer(
    { name: "Whoosh", kind: "effect", asset, startUs: 4_000_000 },
    timeline,
    ids,
  );
  assert.deepEqual(hit.start, {
    type: "source",
    source_id: "source-1",
    source_us: 9_000_000,
  });
  assert.equal(hit.loop, false);
  assert.equal(hit.duck_db, 0);
  assert.equal(hit.gain_db, -6);
  // Plays the whole file once, or the rest of the edit when that is shorter.
  assert.equal(hit.duration_us, 16_000_000);
});

test("an existing id is kept, fades shrink to fit and bad values are refused", () => {
  const short = buildSoundLayer(
    {
      soundId: "sound-keep",
      name: "Blip",
      kind: "effect",
      asset,
      startUs: 0,
      durationUs: 1_000_000,
      fadeInUs: 5_000_000,
      fadeOutUs: 5_000_000,
    },
    timeline,
    ids,
  );
  assert.equal(short.sound_id, "sound-keep");
  assert.ok(short.fade_in_us + short.fade_out_us <= short.duration_us);
  const refused = [
    { startUs: 20_000_000 },
    { assetStartUs: 30_000_000 },
    { gainDb: 40 },
    { duckDb: 40 },
    { durationUs: 10 },
    { name: "   " },
  ];
  for (const patch of refused)
    assert.throws(
      () =>
        buildSoundLayer(
          { name: "Theme", kind: "music", asset, startUs: 0, ...patch },
          timeline,
          ids,
        ),
      SoundBuildError,
      JSON.stringify(patch),
    );
});
