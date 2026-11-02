import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runProcess } from "../../packages/media-engine/src/process.ts";
import {
  duckGain,
  duckingEnvelope,
  duckStepMs,
  mixSoundLayers,
  speechSteps,
  type SoundMixLayer,
} from "../../packages/media-engine/src/sound-mix.ts";
import type { WorkingAudioFormat } from "../../packages/media-engine/src/render.ts";

const rate = 48_000;
const seconds = 4;
const stereo16: WorkingAudioFormat = {
  sampleRate: rate,
  channels: 2,
  channelLayout: "stereo",
  raw: "s16le",
  bits: 16,
};

/** Raw audio: a 440 Hz tone at 0.3 for the given seconds ranges, else silence. */
function speechAudio(
  format: WorkingAudioFormat,
  ranges: [number, number][],
): Buffer {
  const bytes = { s16le: 2, s32le: 4, f32le: 4, f64le: 8 }[format.raw];
  const total = rate * seconds;
  const buffer = Buffer.alloc(total * format.channels * bytes);
  for (let index = 0; index < total; index++) {
    const time = index / rate;
    const on = ranges.some(([from, to]) => time >= from && time < to);
    const value = on ? 0.3 * Math.sin(2 * Math.PI * 440 * time) : 0;
    for (let channel = 0; channel < format.channels; channel++) {
      const at = (index * format.channels + channel) * bytes;
      if (format.raw === "s16le")
        buffer.writeInt16LE(Math.round(value * 32767), at);
      else if (format.raw === "s32le")
        buffer.writeInt32LE(Math.round(value * 2147483647), at);
      else if (format.raw === "f32le") buffer.writeFloatLE(value, at);
      else buffer.writeDoubleLE(value, at);
    }
  }
  return buffer;
}

/** A stereo 44.1 kHz WAV of `frequency` Hz at exactly amplitude 0.5. */
async function tone(path: string, frequency: number, length: number) {
  const wave = `0.5*sin(2*PI*${frequency}*t)`;
  await runProcess({
    executable: "ffmpeg",
    args: [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-f",
      "lavfi",
      "-i",
      `aevalsrc=${wave}|${wave}:s=44100:d=${length}`,
      "-y",
      path,
    ],
    timeoutMs: 60_000,
  });
}

/** Amplitude of `frequency` in the left channel between two times (Goertzel). */
function level(
  audio: Buffer,
  format: WorkingAudioFormat,
  frequency: number,
  from: number,
  to: number,
): number {
  const bytes = { s16le: 2, s32le: 4, f32le: 4, f64le: 8 }[format.raw];
  let real = 0;
  let imaginary = 0;
  const first = Math.round(from * rate);
  const last = Math.round(to * rate);
  for (let index = first; index < last; index++) {
    const at = index * format.channels * bytes;
    const value =
      format.raw === "s16le"
        ? audio.readInt16LE(at) / 32768
        : format.raw === "s32le"
          ? audio.readInt32LE(at) / 2147483648
          : format.raw === "f32le"
            ? audio.readFloatLE(at)
            : audio.readDoubleLE(at);
    const phase = (2 * Math.PI * frequency * index) / rate;
    real += value * Math.cos(phase);
    imaginary -= value * Math.sin(phase);
  }
  return (2 * Math.hypot(real, imaginary)) / (last - first);
}

const layer = (
  path: string,
  patch: Partial<SoundMixLayer> = {},
): SoundMixLayer => ({
  path,
  startUs: 0,
  endUs: seconds * 1_000_000,
  assetStartUs: 0,
  gainDb: 0,
  fadeInUs: 0,
  fadeOutUs: 0,
  duckDb: 0,
  loop: false,
  ...patch,
});

async function mix(
  format: WorkingAudioFormat,
  speech: [number, number][],
  layers: (music: string) => SoundMixLayer[],
  musicSeconds = seconds,
) {
  const root = await mkdtemp(join(tmpdir(), "sound-mix-"));
  try {
    const audioPath = join(root, "audio.raw");
    await writeFile(audioPath, speechAudio(format, speech));
    const music = join(root, "music.wav");
    await tone(music, 880, musicSeconds);
    const sha = await mixSoundLayers({
      ffmpeg: "ffmpeg",
      audio: format,
      audioPath,
      staging: root,
      sampleCount: rate * seconds,
      layers: layers(music),
    });
    const result = await readFile(audioPath);
    assert.equal(sha, createHash("sha256").update(result).digest("hex"));
    return { result, root };
  } finally {
    // The caller reads the result first; the folder goes with the test.
    setImmediate(() => void rm(root, { recursive: true, force: true }));
  }
}

const near = (actual: number, expected: number, tolerance = 0.12) =>
  assert.ok(
    Math.abs(actual - expected) <= expected * tolerance,
    `${actual} is not within ${tolerance * 100}% of ${expected}`,
  );

test("a layer is mixed at its level and the speech is untouched", async () => {
  const { result } = await mix(stereo16, [[0.5, 1.5]], (music) => [
    layer(music, { gainDb: -6 }),
  ]);
  assert.equal(result.length, rate * seconds * 4);
  // Music at half amplitude minus 6 dB (about 0.25), everywhere.
  near(level(result, stereo16, 880, 2.1, 3.9), 0.5 * 10 ** (-6 / 20));
  near(level(result, stereo16, 880, 0.6, 1.4), 0.5 * 10 ** (-6 / 20));
  // The speech tone is where it was, at its level.
  near(level(result, stereo16, 440, 0.6, 1.4), 0.3);
  assert.ok(level(result, stereo16, 440, 2.1, 3.9) < 0.002);
});

test("a layer that ducks is lowered by its decibels under speech and returns after", async () => {
  const { result } = await mix(stereo16, [[1.0, 2.0]], (music) => [
    layer(music, { gainDb: -6, duckDb: 12 }),
  ]);
  const full = 0.5 * 10 ** (-6 / 20);
  // Before the speech: full level. Well inside the speech: 12 dB lower.
  near(level(result, stereo16, 880, 0.2, 0.8), full);
  near(level(result, stereo16, 880, 1.3, 1.9), full * 10 ** (-12 / 20), 0.2);
  // Long after the speech ended: back to full.
  near(level(result, stereo16, 880, 3.2, 3.9), full);
  // The speech itself is not ducked.
  near(level(result, stereo16, 440, 1.3, 1.9), 0.3);
});

test("fades, a late start, a short file and a loop place the sound exactly", async () => {
  // Fade in over 1 s, fade out over 1 s, starting at 1 s and ending at 3.5 s.
  const faded = await mix(stereo16, [], (music) => [
    layer(music, {
      startUs: 1_000_000,
      endUs: 3_500_000,
      fadeInUs: 1_000_000,
      fadeOutUs: 1_000_000,
    }),
  ]);
  assert.ok(level(faded.result, stereo16, 880, 0.2, 0.9) < 0.002);
  assert.ok(level(faded.result, stereo16, 880, 3.6, 3.95) < 0.002);
  assert.ok(level(faded.result, stereo16, 880, 1.0, 1.15) < 0.15);
  near(level(faded.result, stereo16, 880, 1.9, 2.4), 0.5, 0.1);
  assert.ok(level(faded.result, stereo16, 880, 3.35, 3.5) < 0.15);
  // A 1 s file without a loop ends; with a loop it fills the whole layer.
  const short = await mix(stereo16, [], (music) => [layer(music)], 1);
  near(level(short.result, stereo16, 880, 0.2, 0.8), 0.5, 0.1);
  assert.ok(level(short.result, stereo16, 880, 1.5, 3.9) < 0.002);
  const looped = await mix(
    stereo16,
    [],
    (music) => [layer(music, { loop: true })],
    1,
  );
  near(level(looped.result, stereo16, 880, 2.5, 3.9), 0.5, 0.1);
});

test("the mix keeps every working audio format and its exact length", async () => {
  for (const format of [
    stereo16,
    { ...stereo16, raw: "f32le" as const, bits: 32 },
    { ...stereo16, raw: "s32le" as const, bits: 32 },
    { ...stereo16, raw: "f64le" as const, bits: 64 },
    { ...stereo16, channels: 1, channelLayout: "mono" },
  ]) {
    const bytes = { s16le: 2, s32le: 4, f32le: 4, f64le: 8 }[format.raw];
    const { result } = await mix(format, [[0.5, 1.5]], (music) => [
      layer(music, { gainDb: -6, duckDb: 9 }),
    ]);
    assert.equal(result.length, rate * seconds * format.channels * bytes);
    // Mixing the stereo file down to one channel adds its two equal channels
    // (the usual downmix, 3 dB louder); the speech was already mono.
    const down = format.channels === 1 ? Math.SQRT2 : 1;
    near(
      level(result, format, 880, 2.2, 3.8),
      0.5 * 10 ** (-6 / 20) * down,
      0.15,
    );
    near(level(result, format, 440, 0.6, 1.4), 0.3, 0.15);
  }
});

test("a 24-bit master keeps only its 24 bits", async () => {
  const format: WorkingAudioFormat = { ...stereo16, raw: "s32le", bits: 24 };
  const { result } = await mix(format, [[0.5, 1.5]], (music) => [
    layer(music, { gainDb: -6 }),
  ]);
  for (let at = 0; at < result.length; at += 4) {
    if (result[at] !== 0) assert.fail(`sample at byte ${at} has low bits`);
  }
  near(level(result, format, 880, 2.2, 3.8), 0.5 * 10 ** (-6 / 20), 0.15);
});

test("two layers share a ducking depth and others duck differently", async () => {
  const { result } = await mix(stereo16, [[1.0, 2.0]], (music) => [
    layer(music, { gainDb: -6, duckDb: 12 }),
    layer(music, { gainDb: -12, duckDb: 12, startUs: 500_000 }),
    layer(music, { gainDb: -20, duckDb: 6 }),
  ]);
  // Full level is the sum of three tones at the same frequency and phase:
  // 0.25 + 0.125 + 0.05 outside speech.
  near(level(result, stereo16, 880, 3.2, 3.9), 0.25 + 0.125 + 0.05, 0.1);
  near(
    level(result, stereo16, 880, 1.4, 1.9),
    (0.25 + 0.125) * 10 ** (-12 / 20) + 0.05 * 10 ** (-6 / 20),
    0.2,
  );
});

test("speech steps, the ducking envelope and the gain follow the speech", async () => {
  const root = await mkdtemp(join(tmpdir(), "sound-mix-"));
  try {
    const path = join(root, "audio.raw");
    await writeFile(path, speechAudio(stereo16, [[1, 2]]));
    const stepFrames = Math.round((rate * duckStepMs) / 1000);
    const steps = await speechSteps(path, stereo16, stepFrames);
    assert.equal(steps.length, Math.ceil((rate * seconds) / stepFrames));
    const perSecond = 1000 / duckStepMs;
    assert.equal(steps[Math.round(0.5 * perSecond)], 0);
    assert.equal(steps[Math.round(1.5 * perSecond)], 1);
    assert.equal(steps[Math.round(3 * perSecond)], 0);
    const envelope = duckingEnvelope(steps);
    // Rising before the speech starts (look-ahead), full inside, falling after.
    assert.ok(envelope[Math.round(0.9 * perSecond)]! < 0.01);
    assert.ok(envelope[Math.round(1.02 * perSecond)]! > 0.4);
    assert.ok(envelope[Math.round(1.9 * perSecond)]! > 0.97);
    const afterHalfSecond = envelope[Math.round(2.5 * perSecond)]!;
    assert.ok(afterHalfSecond > 0.2 && afterHalfSecond < 0.5);
    assert.ok(envelope[Math.round(3.8 * perSecond)]! < 0.03);
    // Gain: unity with no speech, exactly the chosen decibels when full.
    assert.equal(duckGain(12, 0), 1);
    near(duckGain(12, 1), 10 ** (-12 / 20), 1e-9);
    assert.equal(duckGain(0, 1), 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
