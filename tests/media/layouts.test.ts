import assert from "node:assert/strict";
import test from "node:test";
import {
  assertLayoutChange,
  assertLayoutChanges,
  cameraLayersAt,
  cameraPieces,
  layoutIntervals,
  windowLayoutIntervals,
  type LayoutChange,
} from "../../packages/domain/src/layouts.ts";

const sources = [
  { source_id: "source-a", source_start_us: 0, source_end_us: 60_000_000 },
];
const geometry = { canvasAspect: 16 / 9, cameraAspect: 16 / 9 };
const clip = (
  sourceStartUs: number,
  sourceEndUs: number,
  timelineStartUs: number,
  speed?: number,
) => ({
  sourceId: "source-a",
  sourceStartUs,
  sourceEndUs,
  timelineStartUs,
  timelineEndUs:
    timelineStartUs + Math.round((sourceEndUs - sourceStartUs) / (speed ?? 1)),
  ...(speed ? { speed } : {}),
});
const change = (
  id: string,
  sourceUs: number,
  extra: Partial<LayoutChange> & { kind: LayoutChange["kind"] },
): LayoutChange => ({
  layout_id: id,
  source_id: "source-a",
  source_us: sourceUs,
  ...extra,
});

test("layout changes are validated against their sources", () => {
  assertLayoutChanges(
    [
      change("layout-1", 1_000_000, { kind: "pip", corner: "top_left" }),
      change("layout-2", 9_000_000, { kind: "camera", move_us: 0 }),
    ],
    sources,
  );
  for (const bad of [
    [change("layout-1", 1, { kind: "pip", size: 0.9 })],
    [change("layout-1", 1, { kind: "camera", corner: "top_left" })],
    [change("layout-1", 1, { kind: "screen", face_zoom: 2 })],
    [change("layout-1", 1, { kind: "pip", focus_x: 0.5 })],
    [change("layout-1", 1, { kind: "pip", move_us: 9_000_000 })],
    [change("layout-1", 70_000_000, { kind: "camera" })],
    [
      change("layout-1", 5, { kind: "camera" }),
      change("layout-1", 9, { kind: "pip" }),
    ],
    [
      change("layout-1", 5, { kind: "camera" }),
      change("layout-2", 5, { kind: "pip" }),
    ],
    [{ ...change("layout-1", 5, { kind: "camera" }), extra: 1 }],
  ])
    assert.throws(() => assertLayoutChanges(bad, sources));
  assert.throws(() => assertLayoutChange(null));
});

test("changes follow cuts: a cut-away moment takes effect at the next retained piece", () => {
  // Source 0-10 s then 20-30 s, joined: output 0-10 s, 10-20 s.
  const clips = [
    clip(0, 10_000_000, 0),
    clip(20_000_000, 30_000_000, 10_000_000),
  ];
  const intervals = layoutIntervals(
    [
      change("layout-1", 4_000_000, { kind: "pip" }),
      // Inside the removed part: lands where the next piece starts.
      change("layout-2", 15_000_000, { kind: "camera" }),
      // After everything that is kept: dormant.
      change("layout-3", 45_000_000, { kind: "screen" }),
    ],
    clips,
  );
  assert.deepEqual(
    intervals.map((interval) => [interval.layoutId, interval.startUs]),
    [
      ["layout-1", 4_000_000],
      ["layout-2", 10_000_000],
    ],
  );
  // Speed maps the moment through the clip's rate.
  const fast = layoutIntervals(
    [change("layout-1", 4_000_000, { kind: "pip" })],
    [clip(0, 10_000_000, 0, 2)],
  );
  assert.equal(fast[0]!.startUs, 2_000_000);
});

test("the picture is the screen alone until the first change", () => {
  const intervals = layoutIntervals(
    [change("layout-1", 5_000_000, { kind: "pip", move_us: 0 })],
    [clip(0, 10_000_000, 0)],
  );
  const before = cameraLayersAt(intervals, 1_000_000, geometry);
  assert.deepEqual([before.full, before.pip], [0, null]);
  assert.equal(cameraLayersAt([], 1_000_000, geometry).pip, null);
  assert.equal(cameraLayersAt(intervals, 5_000_000, geometry).pip!.opacity, 1);
});

test("a corner camera sits in its corner with a margin; circles are square", () => {
  const intervals = layoutIntervals(
    [
      change("layout-1", 0, {
        kind: "pip",
        corner: "bottom_right",
        size: 0.25,
        shape: "rounded",
        move_us: 0,
      }),
    ],
    [clip(0, 10_000_000, 0)],
  );
  const pip = cameraLayersAt(intervals, 1_000_000, geometry).pip!;
  assert.ok(Math.abs(pip.width - 0.25) < 1e-9);
  assert.ok(Math.abs(pip.x + pip.width - 0.97) < 1e-9);
  assert.ok(Math.abs(pip.y + pip.height - (1 - 0.03 * (16 / 9))) < 1e-9);
  assert.ok(Math.abs(pip.height - 0.25) < 1e-9);
  const circle = layoutIntervals(
    [
      change("layout-1", 0, {
        kind: "pip",
        shape: "circle",
        size: 0.2,
        move_us: 0,
      }),
    ],
    [clip(0, 10_000_000, 0)],
  );
  const round = cameraLayersAt(circle, 1_000_000, geometry).pip!;
  assert.ok(Math.abs(round.height - round.width * (16 / 9)) < 1e-9);
});

test("changes dissolve and glide: nothing jumps", () => {
  const clips = [clip(0, 60_000_000, 0)];
  const intervals = layoutIntervals(
    [
      change("layout-1", 0, {
        kind: "pip",
        corner: "bottom_right",
        move_us: 0,
      }),
      change("layout-2", 10_000_000, {
        kind: "pip",
        corner: "top_left",
        move_us: 1_000_000,
      }),
      change("layout-3", 20_000_000, { kind: "camera", move_us: 1_000_000 }),
      change("layout-4", 30_000_000, { kind: "pip", move_us: 1_000_000 }),
      change("layout-5", 40_000_000, { kind: "screen", move_us: 1_000_000 }),
    ],
    clips,
  );
  const at = (us: number) => cameraLayersAt(intervals, us, geometry);
  // Gliding between corners.
  const start = at(9_000_000).pip!;
  const mid = at(10_500_000).pip!;
  const end = at(12_000_000).pip!;
  assert.ok(
    mid.x < start.x && mid.x > end.x && mid.y < start.y && mid.y > end.y,
  );
  assert.equal(mid.opacity, 1);
  // The full camera fades in over the corner camera, which stays beneath.
  const half = at(20_500_000);
  assert.ok(half.full > 0 && half.full < 1);
  assert.equal(half.pip!.opacity, 1);
  assert.deepEqual([at(22_000_000).full, at(22_000_000).pip], [1, null]);
  // Back to a corner: the full camera fades out over the corner camera.
  const back = at(30_500_000);
  assert.ok(back.full > 0 && back.full < 1);
  assert.ok(back.pip!.opacity > 0);
  assert.deepEqual([at(32_000_000).full, at(32_000_000).pip!.opacity], [0, 1]);
  // Leaving for the screen fades the corner camera in place.
  const out = at(40_500_000).pip!;
  assert.ok(out.opacity > 0 && out.opacity < 1);
  assert.equal(at(42_000_000).pip, null);
});

test("pieces list steady spans and changes in output time, skipping the screen alone", () => {
  const clips = [clip(0, 60_000_000, 0)];
  const intervals = layoutIntervals(
    [
      change("layout-1", 5_000_000, { kind: "pip", move_us: 1_000_000 }),
      change("layout-2", 20_000_000, { kind: "camera", move_us: 0 }),
      change("layout-3", 30_000_000, { kind: "screen", move_us: 500_000 }),
    ],
    clips,
  );
  const pieces = cameraPieces(intervals, 40_000_000);
  assert.deepEqual(
    pieces.map((piece) => [piece.kind, piece.startUs, piece.endUs]),
    [
      ["change", 5_000_000, 6_000_000],
      ["steady", 6_000_000, 20_000_000],
      ["steady", 20_000_000, 30_000_000],
      ["change", 30_000_000, 30_500_000],
    ],
  );
  // A window shorter than the edit stops where it ends.
  assert.equal(cameraPieces(intervals, 7_000_000).at(-1)!.endUs, 7_000_000);
});

test("a window of the edit opens with the arrangement already in effect", () => {
  const intervals = layoutIntervals(
    [
      change("layout-1", 0, { kind: "pip", move_us: 0 }),
      change("layout-2", 10_000_000, { kind: "camera" }),
    ],
    [clip(0, 20_000_000, 0)],
  );
  const window = windowLayoutIntervals(intervals, 5_000_000, 15_000_000);
  assert.deepEqual(
    window.map((interval) => [interval.layoutId, interval.startUs]),
    [
      ["layout-1", 0],
      ["layout-2", 5_000_000],
    ],
  );
  assert.equal(cameraLayersAt(window, 0, geometry).pip!.opacity, 1);
});
