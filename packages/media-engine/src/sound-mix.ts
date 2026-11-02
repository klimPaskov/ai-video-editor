import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { once } from "node:events";
import { MediaError, runProcess } from "./process.ts";
import type { WorkingAudioFormat } from "./render.ts";

/**
 * Mixes a draft's sound layers (music and effects) into its assembled audio
 * at export. The input and output are the same raw audio in the same format
 * and with exactly the same number of samples, so the mixed audio simply
 * becomes the canonical audio that the export encodes and then verifies.
 *
 * Each layer is rendered to its own track (level, fades), placed at its
 * start, lowered under speech where it asks to be, and summed with the
 * speech. Ducking is exact: how loud the speech is decides a smooth envelope
 * (quick to duck, slow to come back), and a layer is lowered by exactly its
 * chosen decibels while the envelope is at full.
 */

export interface SoundMixLayer {
  /** The audio file (already verified by the caller). */
  path: string;
  startUs: number;
  endUs: number;
  assetStartUs: number;
  gainDb: number;
  fadeInUs: number;
  fadeOutUs: number;
  duckDb: number;
  loop: boolean;
}

const quiet = ["-hide_banner", "-loglevel", "error", "-nostdin"];
const sampleBytes: Record<WorkingAudioFormat["raw"], number> = {
  s16le: 2,
  s32le: 4,
  f32le: 4,
  f64le: 8,
};
const sampleFormat: Record<WorkingAudioFormat["raw"], string> = {
  s16le: "s16",
  s32le: "s32",
  f32le: "flt",
  f64le: "dbl",
};

/** Speech level (RMS, dBFS) above which a 5 ms step counts as speech. */
export const speechThresholdDb = -48;
/** The envelope looks ahead so the music is already down as a word starts. */
const lookAheadSteps = 8;
export const duckStepMs = 5;

const seconds = (us: number) => (us / 1_000_000).toFixed(6);

/** Which 5 ms steps of the audio hold speech (above the threshold). */
export async function speechSteps(
  audioPath: string,
  audio: WorkingAudioFormat,
  stepFrames: number,
): Promise<Uint8Array> {
  const bytes = sampleBytes[audio.raw];
  const frameBytes = bytes * audio.channels;
  const total = Math.floor((await stat(audioPath)).size / frameBytes);
  const steps = new Uint8Array(Math.ceil(total / stepFrames));
  let step = 0;
  let framesInStep = 0;
  let sum = 0;
  let pending = Buffer.alloc(0);
  const flush = () => {
    const mean = sum / (framesInStep * audio.channels);
    const db = mean > 0 ? 10 * Math.log10(mean) : -200;
    steps[step++] = db > speechThresholdDb ? 1 : 0;
    framesInStep = 0;
    sum = 0;
  };
  const read = (buffer: Buffer, offset: number): number => {
    switch (audio.raw) {
      case "s16le":
        return buffer.readInt16LE(offset) / 32768;
      case "s32le":
        return buffer.readInt32LE(offset) / 2147483648;
      case "f32le":
        return buffer.readFloatLE(offset);
      default:
        return buffer.readDoubleLE(offset);
    }
  };
  for await (const chunk of createReadStream(audioPath)) {
    const data = pending.length
      ? Buffer.concat([pending, chunk as Buffer])
      : (chunk as Buffer);
    const whole = data.length - (data.length % frameBytes);
    for (let at = 0; at < whole; at += frameBytes) {
      for (let channel = 0; channel < audio.channels; channel++) {
        const value = read(data, at + channel * bytes);
        sum += value * value;
      }
      if (++framesInStep === stepFrames) flush();
    }
    pending = Buffer.from(data.subarray(whole));
  }
  if (framesInStep > 0) flush();
  return steps;
}

/**
 * The ducking envelope, 0 (no speech) to 1 (fully ducked), one value per
 * step: it rises within about 30 ms of speech and falls back over about
 * 450 ms, and starts 40 ms before the speech does.
 */
export function duckingEnvelope(steps: Uint8Array): Float32Array {
  const envelope = new Float32Array(steps.length);
  const rise = 1 - Math.exp(-duckStepMs / 30);
  const fall = Math.exp(-duckStepMs / 450);
  let value = 0;
  for (let index = 0; index < steps.length; index++) {
    const speech =
      steps[Math.min(steps.length - 1, index + lookAheadSteps)] === 1;
    value = speech ? value + (1 - value) * rise : value * fall;
    envelope[index] = value;
  }
  return envelope;
}

/** The linear gain a layer ducked by `duckDb` has where the envelope is `e`. */
export function duckGain(duckDb: number, e: number): number {
  return 1 - (1 - 10 ** (-duckDb / 20)) * e;
}

/** A file writer that waits for the disk and reports its first failure. */
function openWriter(path: string) {
  const stream = createWriteStream(path, { mode: 0o600 });
  let failure: Error | null = null;
  stream.on("error", (error) => {
    failure ??= error;
  });
  return {
    async write(chunk: Buffer): Promise<void> {
      if (failure) throw failure;
      if (!stream.write(chunk)) await once(stream, "drain").catch(() => {});
      if (failure) throw failure;
    },
    async end(): Promise<void> {
      await new Promise<void>((resolve) => stream.end(resolve));
      if (failure) throw failure;
    },
  };
}

/**
 * A mono float track, one sample per audio sample, holding the gain a layer
 * ducked by `duckDb` should have at that time (the envelope, interpolated
 * between its 5 ms steps).
 */
async function writeControlTrack(
  path: string,
  envelope: Float32Array,
  stepFrames: number,
  sampleCount: number,
  duckDb: number,
): Promise<void> {
  const output = openWriter(path);
  try {
    const block = 1 << 16;
    for (let start = 0; start < sampleCount; start += block) {
      const length = Math.min(block, sampleCount - start);
      const values = new Float32Array(length);
      for (let index = 0; index < length; index++) {
        const position = (start + index) / stepFrames;
        const step = Math.floor(position);
        const fraction = position - step;
        const a = envelope[Math.min(step, envelope.length - 1)] ?? 0;
        const b = envelope[Math.min(step + 1, envelope.length - 1)] ?? a;
        values[index] = duckGain(duckDb, a + (b - a) * fraction);
      }
      await output.write(
        Buffer.from(values.buffer, values.byteOffset, values.byteLength),
      );
    }
  } finally {
    await output.end();
  }
}

/** Zeroes the low byte of each 32-bit sample: the 24 bits a 24-bit master keeps. */
async function keep24Bits(path: string): Promise<void> {
  const temporary = `${path}.24`;
  const output = openWriter(temporary);
  let offset = 0;
  try {
    for await (const chunk of createReadStream(path)) {
      const data = Buffer.from(chunk as Buffer);
      for (let index = 0; index < data.length; index++)
        if ((offset + index) % 4 === 0) data[index] = 0;
      offset += data.length;
      await output.write(data);
    }
  } finally {
    await output.end();
  }
  await rename(temporary, path);
}

export async function mixSoundLayers(options: {
  ffmpeg: string;
  audio: WorkingAudioFormat;
  /** The assembled audio, replaced by the mix. */
  audioPath: string;
  staging: string;
  sampleCount: number;
  layers: readonly SoundMixLayer[];
  signal?: AbortSignal;
}): Promise<string> {
  const { audio, layers } = options;
  const run = (args: string[]) =>
    runProcess({
      executable: options.ffmpeg,
      args,
      timeoutMs: 30 * 60_000,
      maxOutputBytes: 1 << 20,
      ...(options.signal ? { signal: options.signal } : {}),
    });
  const files: string[] = [];
  try {
    // 1. Each layer on its own: level, fades, at the working rate and layout.
    const tracks: string[] = [];
    for (const [index, layer] of layers.entries()) {
      const duration = layer.endUs - layer.startUs;
      const filters = [
        ...(layer.assetStartUs > 0
          ? [`atrim=start=${seconds(layer.assetStartUs)}`]
          : []),
        "asetpts=N/SR/TB",
        `aresample=${audio.sampleRate}`,
        `aformat=sample_fmts=flt:channel_layouts=${audio.channelLayout}`,
        ...(layer.gainDb !== 0 ? [`volume=${layer.gainDb}dB`] : []),
        ...(layer.fadeInUs > 0
          ? [`afade=t=in:st=0:d=${seconds(layer.fadeInUs)}`]
          : []),
        ...(layer.fadeOutUs > 0
          ? [
              `afade=t=out:st=${seconds(duration - layer.fadeOutUs)}:d=${seconds(layer.fadeOutUs)}`,
            ]
          : []),
      ];
      const track = join(options.staging, `sound-${index}.raw`);
      files.push(track);
      await run([
        ...quiet,
        ...(layer.loop ? ["-stream_loop", "-1"] : []),
        "-i",
        layer.path,
        "-map",
        "0:a:0",
        "-vn",
        "-af",
        filters.join(","),
        "-t",
        seconds(duration),
        "-c:a",
        "pcm_f32le",
        "-f",
        "f32le",
        track,
      ]);
      tracks.push(track);
    }

    // 2. Ducking: one control track per distinct depth, from the speech.
    const depths = [
      ...new Set(layers.map((layer) => layer.duckDb).filter((db) => db > 0)),
    ].sort((a, b) => a - b);
    const controls = new Map<number, string>();
    if (depths.length) {
      const stepFrames = Math.max(
        1,
        Math.round((audio.sampleRate * duckStepMs) / 1000),
      );
      const envelope = duckingEnvelope(
        await speechSteps(options.audioPath, audio, stepFrames),
      );
      for (const [index, depth] of depths.entries()) {
        const control = join(options.staging, `duck-${index}.raw`);
        files.push(control);
        await writeControlTrack(
          control,
          envelope,
          stepFrames,
          options.sampleCount,
          depth,
        );
        controls.set(depth, control);
      }
    }

    // 3. The mix: every layer delayed to its start (and lowered where it
    // ducks), summed with the speech, kept below full scale.
    const inputs: string[] = [
      "-f",
      audio.raw,
      "-ar",
      String(audio.sampleRate),
      "-ch_layout",
      audio.channelLayout,
      "-i",
      options.audioPath,
    ];
    for (const track of tracks)
      inputs.push(
        "-f",
        "f32le",
        "-ar",
        String(audio.sampleRate),
        "-ch_layout",
        audio.channelLayout,
        "-i",
        track,
      );
    const controlInputs = new Map<number, number>();
    for (const [depth, control] of controls) {
      controlInputs.set(depth, 1 + tracks.length + controlInputs.size);
      inputs.push(
        "-f",
        "f32le",
        "-ar",
        String(audio.sampleRate),
        "-ac",
        "1",
        "-i",
        control,
      );
    }
    const format = `aformat=sample_fmts=fltp:channel_layouts=${audio.channelLayout}`;
    const spread = `pan=${audio.channelLayout}|${Array.from(
      { length: audio.channels },
      (_, channel) => `c${channel}=c0`,
    ).join("|")}`;
    const graph: string[] = [`[0:a]${format}[speech]`];
    // A control track feeds one layer per use, so it is split.
    const uses = new Map<number, number>();
    for (const layer of layers)
      if (layer.duckDb > 0)
        uses.set(layer.duckDb, (uses.get(layer.duckDb) ?? 0) + 1);
    const taken = new Map<number, number>();
    for (const [depth, input] of controlInputs) {
      const count = uses.get(depth) ?? 1;
      graph.push(
        `[${input}:a]${spread},${format},asplit=${count}${Array.from(
          { length: count },
          (_, copy) => `[duck${input}_${copy}]`,
        ).join("")}`,
      );
    }
    const mixed: string[] = ["[speech]"];
    for (const [index, layer] of layers.entries()) {
      const delay = Math.round((layer.startUs * audio.sampleRate) / 1_000_000);
      const input = 1 + index;
      graph.push(
        `[${input}:a]${format},adelay=${delay}S:all=1[placed${index}]`,
      );
      if (layer.duckDb > 0) {
        const control = controlInputs.get(layer.duckDb)!;
        const copy = taken.get(layer.duckDb) ?? 0;
        taken.set(layer.duckDb, copy + 1);
        graph.push(
          `[placed${index}][duck${control}_${copy}]amultiply[mix${index}]`,
        );
      } else graph.push(`[placed${index}]anull[mix${index}]`);
      mixed.push(`[mix${index}]`);
    }
    graph.push(
      `${mixed.join("")}amix=inputs=${mixed.length}:duration=first:normalize=0:dropout_transition=0,alimiter=limit=0.98,aresample=${audio.sampleRate},aformat=sample_fmts=${sampleFormat[audio.raw]},apad,atrim=end_sample=${options.sampleCount}[out]`,
    );
    const mixedPath = join(options.staging, "mixed-audio.raw");
    files.push(mixedPath);
    await run([
      ...quiet,
      ...inputs,
      "-filter_complex",
      graph.join(";"),
      "-map",
      "[out]",
      "-c:a",
      `pcm_${audio.raw}`,
      "-f",
      audio.raw,
      mixedPath,
    ]);
    const expected =
      options.sampleCount * sampleBytes[audio.raw] * audio.channels;
    if ((await stat(mixedPath)).size !== expected)
      throw new MediaError(
        "FIDELITY_MISMATCH",
        "Mixed audio does not match the draft length.",
      );
    if (audio.raw === "s32le" && audio.bits === 24) await keep24Bits(mixedPath);
    await rename(mixedPath, options.audioPath);
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(options.audioPath))
      hash.update(chunk as Buffer);
    return hash.digest("hex");
  } finally {
    for (const file of files) await rm(file, { force: true });
  }
}
