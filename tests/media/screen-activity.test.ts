import assert from "node:assert/strict";
import test from "node:test";
import {
  findActivityTargets,
  zoomForTarget,
} from "../../packages/domain/src/screen-activity.ts";

const width = 160;
const height = 90;

function blank(): Uint8Array {
  return new Uint8Array(width * height).fill(40);
}

/** Paints a square of `value` at pixel position (x, y). */
function paint(
  frame: Uint8Array,
  x: number,
  y: number,
  size: number,
  value: number,
) {
  for (let row = y; row < y + size; row++)
    for (let column = x; column < x + size; column++)
      frame[row * width + column] = value;
}

test("a local change over several frames becomes one event with a rectangle", () => {
  const frames: Uint8Array[] = [];
  for (let index = 0; index < 20; index++) {
    const frame = blank();
    // From frame 6 to 14 a text-like patch flickers in the right-hand part.
    if (index >= 6 && index <= 14)
      paint(frame, 100, 20, 30, index % 2 ? 220 : 120);
    frames.push(frame);
  }
  const events = findActivityTargets(frames, width, height, 200_000);
  assert.equal(events.length, 1);
  const [event] = events;
  assert.ok(event!.startUs >= 1_000_000 && event!.startUs <= 1_600_000);
  assert.ok(event!.endUs >= 2_600_000 && event!.endUs <= 3_200_000);
  assert.ok(event!.x >= 0.55 && event!.x + event!.width <= 0.95);
  assert.ok(event!.y >= 0.15 && event!.y + event!.height <= 0.6);
  const zoom = zoomForTarget(event!);
  assert.ok(zoom.centerX > 0.6 && zoom.centerX < 0.9);
  assert.ok(zoom.scale >= 1.3 && zoom.scale <= 2.4);
});

test("a change across the whole picture is not a place to look", () => {
  const frames: Uint8Array[] = [];
  for (let index = 0; index < 12; index++)
    frames.push(new Uint8Array(width * height).fill(index % 2 ? 200 : 40));
  assert.deepEqual(findActivityTargets(frames, width, height, 200_000), []);
});

test("one-frame flicker and a still picture produce nothing", () => {
  const still = Array.from({ length: 10 }, blank);
  assert.deepEqual(findActivityTargets(still, width, height, 200_000), []);
  const flicker = Array.from({ length: 10 }, (_, index) => {
    const frame = blank();
    if (index === 4) paint(frame, 20, 20, 30, 250);
    return frame;
  });
  assert.deepEqual(findActivityTargets(flicker, width, height, 200_000), []);
});

test("two separate places are two events", () => {
  const frames: Uint8Array[] = [];
  for (let index = 0; index < 40; index++) {
    const frame = blank();
    if (index >= 3 && index <= 10)
      paint(frame, 10, 10, 30, index % 2 ? 220 : 120);
    if (index >= 25 && index <= 34)
      paint(frame, 110, 55, 30, index % 2 ? 220 : 120);
    frames.push(frame);
  }
  const events = findActivityTargets(frames, width, height, 200_000);
  assert.equal(events.length, 2);
  assert.ok(events[0]!.x < 0.4 && events[1]!.x > 0.5);
  assert.ok(events[0]!.endUs < events[1]!.startUs);
});
