import assert from "node:assert/strict";
import test from "node:test";
import {
  assertLayoutChange,
  assertLayoutChanges,
  cameraFrameAt,
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
  assert.equal(cameraFrameAt(intervals, 1_000_000, geometry).opacity, 0);
  assert.equal(cameraFrameAt([], 1_000_000, geometry).opacity, 0);
  assert.equal(cameraFrameAt(intervals, 5_000_000, geometry).opacity, 1);
});

test("a corner camera sits in its corner with a margin, circles are square", () => {
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
  const frame = cameraFrameAt(intervals, 1_000_000, geometry);
  assert.equal(frame.full, false);
  assert.ok(Math.abs(frame.width - 0.25) < 1e-9);
  assert.ok(Math.abs(frame.x + frame.width - 0.97) < 1e-9);
  assert.ok(Math.abs(frame.y + frame.height - (1 - 0.03 * (16 / 9))) < 1e-9);
  // The camera keeps its 16:9 shape: 0.25 of the width is 0.25 * 16/9 / (16/9) tall.
  assert.ok(Math.abs(frame.height - 0.25) < 1e-9);
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
  const round = cameraFrameAt(circle, 1_000_000, geometry);
  // Square in pixels: height share = width share * aspect.
  assert.ok(Math.abs(round.height - round.width * (16 / 9)) < 1e-9);
});

test("a corner camera glides to another corner, grows to full and fades in and out", () => {
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
      change("layout-4", 30_000_000, { kind: "screen", move_us: 1_000_000 }),
    ],
    clips,
  );
  const at = (us: number) => cameraFrameAt(intervals, us, geometry);
  // Gliding: halfway through the move the camera is between the corners.
  const start = at(9_000_000);
  const mid = at(10_500_000);
  const end = at(12_000_000);
  assert.ok(mid.x < start.x && mid.x > end.x);
  assert.ok(mid.y < start.y && mid.y > end.y);
  assert.equal(mid.opacity, 1);
  // Growing: the rectangle expands and ends covering the picture.
  assert.ok(at(20_500_000).width > end.width && at(20_500_000).width < 1);
  assert.equal(at(22_000_000).full, true);
  assert.equal(at(22_000_000).width, 1);
  // Fading out in place once the screen comes back.
  assert.ok(at(30_500_000).opacity > 0 && at(30_500_000).opacity < 1);
  assert.equal(at(32_000_000).opacity, 0);
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
  assert.equal(cameraFrameAt(window, 0, geometry).opacity, 1);
});
