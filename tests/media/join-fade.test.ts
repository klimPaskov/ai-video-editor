import assert from "node:assert/strict";
import test from "node:test";
import {
  fadeClipEdges,
  joinFadeFrames,
} from "../../packages/media-engine/src/join-fade.ts";

function constant16(frames: number, channels: number, value: number): Buffer {
  const buffer = Buffer.alloc(frames * channels * 2);
  for (let index = 0; index < frames * channels; index++)
    buffer.writeInt16LE(value, index * 2);
  return buffer;
}

test("a join fade is a few milliseconds and never more than a third of a clip", () => {
  assert.equal(joinFadeFrames(48_000, 10, 100_000), 480);
  assert.equal(joinFadeFrames(48_000, 10, 300), 100);
  assert.equal(joinFadeFrames(48_000, 0, 100_000), 0);
});

test("the edges of a clip fade to near silence and the middle is untouched", () => {
  const frames = 1000;
  const buffer = constant16(frames, 2, 10_000);
  fadeClipEdges(buffer, 0, {
    raw: "s16le",
    channels: 2,
    totalFrames: frames,
    inFrames: 100,
    outFrames: 100,
  });
  const at = (frame: number, channel = 0) =>
    buffer.readInt16LE((frame * 2 + channel) * 2);
  assert.ok(Math.abs(at(0)) < 200);
  assert.ok(Math.abs(at(frames - 1)) < 200);
  assert.equal(at(500), 10_000);
  assert.equal(at(500, 1), 10_000);
  // Rising on entry, falling on exit, both channels alike.
  assert.ok(at(20) < at(60) && at(60) < at(99));
  assert.ok(at(frames - 20) < at(frames - 60));
  assert.equal(at(30, 0), at(30, 1));
});

test("fading in pieces gives the same samples as fading in one go", () => {
  const frames = 600;
  const whole = constant16(frames, 2, 8000);
  const parts = Buffer.from(whole);
  const options = {
    raw: "s16le" as const,
    channels: 2,
    totalFrames: frames,
    inFrames: 90,
    outFrames: 90,
  };
  fadeClipEdges(whole, 0, options);
  const cut = 700;
  fadeClipEdges(parts.subarray(0, cut), 0, options);
  fadeClipEdges(parts.subarray(cut), cut, options);
  assert.deepEqual(parts, whole);
});

test("float audio fades by gain too", () => {
  const buffer = Buffer.alloc(8 * 4);
  for (let index = 0; index < 8; index++) buffer.writeFloatLE(0.5, index * 4);
  fadeClipEdges(buffer, 0, {
    raw: "f32le",
    channels: 1,
    totalFrames: 8,
    inFrames: 2,
    outFrames: 0,
  });
  assert.ok(buffer.readFloatLE(0) < 0.5 && buffer.readFloatLE(0) > 0);
  assert.equal(buffer.readFloatLE(4 * 4), 0.5);
});
