import assert from "node:assert/strict";
import test from "node:test";
import {
  isQuietSpan,
  meanEnergy,
  quietestWindowStart,
  speechLevel,
  type EnergyTrack,
} from "../../packages/domain/src/audio-energy.ts";

function track(frames: number[]): EnergyTrack {
  return { frameUs: 10_000, rms: Float32Array.from(frames) };
}

test("mean energy averages the frames of a span and ignores what is outside the track", () => {
  const t = track([0.1, 0.1, 0.5, 0.5]);
  assert.ok(Math.abs(meanEnergy(t, 0, 40_000) - 0.3) < 1e-6);
  assert.ok(Math.abs(meanEnergy(t, 20_000, 40_000) - 0.5) < 1e-6);
  assert.equal(meanEnergy(t, 100_000, 200_000), 0);
  assert.equal(meanEnergy(t, 30_000, 30_000), 0);
  // A span that runs past the end uses only the frames there are.
  assert.ok(Math.abs(meanEnergy(t, 20_000, 400_000) - 0.5) < 1e-6);
});

test("the quietest window avoids a noisy edge and sits in the middle when all is equal", () => {
  // 1 s of frames: a breath in frames 0-19, then silence.
  const frames = new Array(100).fill(0.001);
  frames.fill(0.05, 0, 20);
  const t = track(frames);
  const start = quietestWindowStart(t, 0, 1_000_000, 500_000);
  assert.ok(start >= 200_000, `starts at ${start}`);
  // Equal energy everywhere: the middle.
  const flat = track(new Array(100).fill(0.001));
  assert.equal(quietestWindowStart(flat, 0, 1_000_000, 400_000), 300_000);
  // A window as long as the span has one place to be.
  assert.equal(quietestWindowStart(flat, 100_000, 500_000, 400_000), 100_000);
  assert.equal(quietestWindowStart(flat, 100_000, 300_000, 400_000), 100_000);
});

test("speech level ignores the noise floor; quiet spans are those well under it", () => {
  const frames = new Array(100).fill(0.001);
  frames.fill(0.2, 40, 90);
  const t = track(frames);
  const level = speechLevel(t);
  assert.ok(level > 0.15 && level <= 0.2001, `level ${level}`);
  assert.equal(isQuietSpan(t, 0, 300_000), true);
  assert.equal(isQuietSpan(t, 500_000, 800_000), false);
  // A span that is part speech, part silence is judged by its mean.
  assert.equal(isQuietSpan(t, 300_000, 600_000), false);
  // A silent track has no speech level: everything counts as quiet.
  assert.equal(speechLevel(track([0, 0, 0.001])), 0);
  assert.equal(isQuietSpan(track([0, 0]), 0, 20_000), true);
});
