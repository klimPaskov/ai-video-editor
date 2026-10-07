import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { once } from "node:events";
import type { Readable, Writable } from "node:stream";
import { MediaError, runProcess } from "./process.ts";
import { atempoChain } from "../../domain/src/speed.ts";
import type { PresentationTiming } from "./presentation-timing.ts";
import type { MediaExecutables } from "./lossless.ts";
import { publishFileWithoutOverwrite } from "./files.ts";

/**
 * Draft export: renders the committed timeline from immutable sources into a
 * verified master. Each clip's video frames and audio samples are decoded
 * from the source, hashed as the canonical render and fed unchanged to the
 * encoder; the encoded file is then fully decoded and must reproduce the same
 * hashes before it is published.
 */

export type ExportProfile = "lossless_master" | "smaller_mp4";

export interface ExportClip {
  sourceId: string;
  sourceStartUs: number;
  sourceEndUs: number;
  /** Whole-number speed-up; absent means normal speed. */
  speed?: number;
}

export interface ExportSource {
  sourceId: string;
  path: string;
  sha256: string;
  probe: Record<string, unknown>;
  timing: PresentationTiming;
}

interface Rational {
  numerator: number;
  denominator: number;
}

export interface WorkingVideoFormat {
  width: number;
  height: number;
  pixelFormat: string;
  frameRate: Rational;
  color: {
    range?: string;
    space?: string;
    primaries?: string;
    transfer?: string;
  };
}

export interface WorkingAudioFormat {
  sampleRate: number;
  channels: number;
  channelLayout: string;
  /** Raw little-endian PCM representation that preserves decoded samples. */
  raw: "s16le" | "s32le" | "f32le" | "f64le";
  /** Bits a 32-bit integer source actually carries (24 or 32). */
  bits: number;
}

export interface WorkingFormat {
  video: WorkingVideoFormat;
  audio: WorkingAudioFormat | null;
}

export interface PlannedClip {
  sourceId: string;
  path: string;
  /** Source frame indexes [firstFrame, endFrame). */
  firstFrame: number;
  frameCount: number;
  /** Trim window in seconds with half-frame margins around the kept frames. */
  trimStartSeconds: number;
  trimEndSeconds: number;
  seekSeconds: number;
  /** Source audio samples [firstSample, endSample) covering the same frames. */
  firstSample: number;
  sampleCount: number;
  /**
   * Whole-number speed-up. The output keeps every `speed`-th source frame
   * (`outputFrames` of them) and time-stretches the source audio to
   * `outputSamples` without changing its pitch.
   */
  speed: number;
  outputFrames: number;
  outputSamples: number;
}

export interface ExportPlan {
  format: WorkingFormat;
  clips: PlannedClip[];
  frameCount: number;
  sampleCount: number;
  frameBytes: number;
  sourceHashes: Record<string, string>;
}

export interface ExportEvidence {
  profile: ExportProfile;
  ffmpegVersion: string;
  outputSha256: string;
  outputBytes: number;
  frameCount: number;
  audioSampleCount: number;
  durationUs: number;
  canonicalVideoSha256: string;
  canonicalAudioSha256: string | null;
  /** True only when decoded master samples equal the canonical render. */
  samplesEqual: boolean;
  decodedVideoSha256: string;
  decodedAudioSha256: string | null;
  sourceHashesUnchanged: true;
  format: WorkingFormat;
  container: "matroska" | "mp4";
  videoCodec: "ffv1" | "h264";
  audioCodec: string | null;
}

export interface ExportProgress {
  phase: "rendering" | "verifying";
  /** 0..1 across the whole export. */
  fraction: number;
}

function unsupported(message: string): never {
  throw new MediaError("UNSUPPORTED_PROFILE", message);
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function gcd(a: bigint, b: bigint): bigint {
  while (b) [a, b] = [b, a % b];
  return a;
}

/** Bytes per frame for the planar/packed layouts this export verifies. */
const pixelLayouts: Record<
  string,
  {
    planes: "yuv" | "packed" | "gbr" | "gray";
    sub?: [number, number];
    bytes: number;
    components?: number;
  }
> = {
  yuv420p: { planes: "yuv", sub: [2, 2], bytes: 1 },
  yuv422p: { planes: "yuv", sub: [2, 1], bytes: 1 },
  yuv444p: { planes: "yuv", sub: [1, 1], bytes: 1 },
  yuv420p10le: { planes: "yuv", sub: [2, 2], bytes: 2 },
  yuv422p10le: { planes: "yuv", sub: [2, 1], bytes: 2 },
  yuv444p10le: { planes: "yuv", sub: [1, 1], bytes: 2 },
  yuv420p12le: { planes: "yuv", sub: [2, 2], bytes: 2 },
  yuv422p12le: { planes: "yuv", sub: [2, 1], bytes: 2 },
  yuv444p12le: { planes: "yuv", sub: [1, 1], bytes: 2 },
  yuv420p16le: { planes: "yuv", sub: [2, 2], bytes: 2 },
  yuv422p16le: { planes: "yuv", sub: [2, 1], bytes: 2 },
  yuv444p16le: { planes: "yuv", sub: [1, 1], bytes: 2 },
  bgra: { planes: "packed", bytes: 1, components: 4 },
  bgr0: { planes: "packed", bytes: 1, components: 4 },
  gbrp: { planes: "gbr", bytes: 1 },
  gbrp10le: { planes: "gbr", bytes: 2 },
  gbrp12le: { planes: "gbr", bytes: 2 },
  gbrp16le: { planes: "gbr", bytes: 2 },
  gray: { planes: "gray", bytes: 1 },
  gray10le: { planes: "gray", bytes: 2 },
  gray12le: { planes: "gray", bytes: 2 },
  gray16le: { planes: "gray", bytes: 2 },
};

export const exportPixelFormats = Object.freeze(Object.keys(pixelLayouts));

export function rawFrameBytes(
  pixelFormat: string,
  width: number,
  height: number,
): number {
  const layout = pixelLayouts[pixelFormat];
  if (!layout)
    unsupported("This video's pixel format cannot be exported losslessly yet.");
  const luma = width * height;
  switch (layout.planes) {
    case "packed":
      return luma * layout.components! * layout.bytes;
    case "gbr":
      return luma * 3 * layout.bytes;
    case "gray":
      return luma * layout.bytes;
    case "yuv": {
      const [sx, sy] = layout.sub!;
      const chroma = Math.ceil(width / sx) * Math.ceil(height / sy);
      return (luma + 2 * chroma) * layout.bytes;
    }
  }
}

const sampleFormats: Record<
  string,
  { raw: WorkingAudioFormat["raw"]; bits: number }
> = {
  s16: { raw: "s16le", bits: 16 },
  s16p: { raw: "s16le", bits: 16 },
  s32: { raw: "s32le", bits: 32 },
  s32p: { raw: "s32le", bits: 32 },
  flt: { raw: "f32le", bits: 32 },
  fltp: { raw: "f32le", bits: 32 },
  dbl: { raw: "f64le", bits: 64 },
  dblp: { raw: "f64le", bits: 64 },
};

const rawSampleBytes: Record<WorkingAudioFormat["raw"], number> = {
  s16le: 2,
  s32le: 4,
  f32le: 4,
  f64le: 8,
};

function streams(probe: Record<string, unknown>): Record<string, unknown>[] {
  if (!Array.isArray(probe.streams)) unsupported("This source cannot be read.");
  return probe.streams.filter(object);
}

function colorTag(value: unknown): string | undefined {
  return typeof value === "string" && value && value !== "unknown"
    ? value
    : undefined;
}

function rationalOf(value: unknown): Rational | null {
  const match =
    typeof value === "string" ? /^(\d+)\/(\d+)$/u.exec(value) : null;
  if (!match) return null;
  const n = BigInt(match[1]!);
  const d = BigInt(match[2]!);
  if (n <= 0n || d <= 0n) return null;
  const g = gcd(n, d);
  return { numerator: Number(n / g), denominator: Number(d / g) };
}

/**
 * The source's constant frame rate. Containers with coarse clocks (Matroska
 * stores milliseconds) round 30 fps to 33/34 ms steps, so a source counts as
 * constant-rate when every frame is within one tick (at least 1 ms) of
 * `index / rate`; frame and sample positions then use the exact rate.
 */
export function nominalFrameRate(
  video: Record<string, unknown>,
  timing: PresentationTiming,
): Rational {
  const { pts, timeBaseNumerator: tbn, timeBaseDenominator: tbd } = timing;
  if (pts.length < 1 || pts[0] !== 0)
    unsupported("This video's frame timing cannot be verified.");
  let rate = rationalOf(video.r_frame_rate) ?? rationalOf(video.avg_frame_rate);
  if (!rate || rate.numerator / rate.denominator > 1000) {
    const ticks = pts.length > 1 ? pts[1]! - pts[0]! : timing.lastDurationTicks;
    if (!ticks || ticks <= 0)
      unsupported("This video's frame timing cannot be verified.");
    rate = rationalOf(`${tbd}/${tbn * ticks}`);
  }
  if (!rate) unsupported("This video's frame timing cannot be verified.");
  const tolerance = Math.max(tbn / tbd, 0.001) + 1e-9;
  const frameSeconds = rate.denominator / rate.numerator;
  for (let index = 0; index < pts.length; index++)
    if (Math.abs((pts[index]! * tbn) / tbd - index * frameSeconds) > tolerance)
      unsupported("Variable frame rate video cannot be exported yet.");
  return rate;
}

/** Exact working format of one source, or an explicit unsupported error. */
export function workingFormat(
  probe: Record<string, unknown>,
  timing: PresentationTiming,
): WorkingFormat {
  const all = streams(probe);
  const video = all.find((stream) => stream.codec_type === "video");
  if (!video) unsupported("This source has no video stream.");
  const width = Number(video.width);
  const height = Number(video.height);
  const pixelFormat = String(video.pix_fmt);
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    width > 16384 ||
    height > 16384
  )
    unsupported("This video's dimensions cannot be exported.");
  if (!pixelLayouts[pixelFormat])
    unsupported("This video's pixel format cannot be exported losslessly yet.");
  if (
    video.sample_aspect_ratio !== undefined &&
    video.sample_aspect_ratio !== "1:1" &&
    video.sample_aspect_ratio !== "0:1"
  )
    unsupported("Non-square pixels cannot be exported yet.");
  if (
    typeof video.field_order === "string" &&
    !["progressive", "unknown"].includes(video.field_order)
  )
    unsupported("Interlaced video cannot be exported yet.");
  if (
    (object(video.tags) &&
      video.tags.rotate !== undefined &&
      video.tags.rotate !== "0") ||
    (Array.isArray(video.side_data_list) &&
      video.side_data_list.some(
        (item: unknown) =>
          object(item) &&
          item.side_data_type === "Display Matrix" &&
          Number(item.rotation ?? 0) !== 0,
      ))
  )
    unsupported("Rotated video cannot be exported yet.");
  const frameRate = nominalFrameRate(video, timing);
  const audioStream = all.find((stream) => stream.codec_type === "audio");
  let audio: WorkingAudioFormat | null = null;
  if (audioStream) {
    const sample = sampleFormats[String(audioStream.sample_fmt)];
    const sampleRate = Number(audioStream.sample_rate);
    const channels = Number(audioStream.channels);
    if (
      !sample ||
      !Number.isSafeInteger(sampleRate) ||
      sampleRate < 8000 ||
      sampleRate > 384000 ||
      !Number.isSafeInteger(channels) ||
      channels < 1 ||
      channels > 8
    )
      unsupported("This audio format cannot be exported losslessly yet.");
    const start = Number(audioStream.start_time ?? 0);
    if (start !== 0)
      unsupported("Audio that starts after the video cannot be exported yet.");
    const bitsRaw = Number(audioStream.bits_per_raw_sample);
    audio = {
      sampleRate,
      channels,
      channelLayout:
        typeof audioStream.channel_layout === "string" &&
        /^[a-z0-9.()+-]{1,32}$/u.test(audioStream.channel_layout)
          ? audioStream.channel_layout
          : channels === 1
            ? "mono"
            : channels === 2
              ? "stereo"
              : unsupported(
                  "This audio channel layout cannot be exported yet.",
                ),
      raw: sample.raw,
      bits: sample.raw === "s32le" && bitsRaw === 24 ? 24 : sample.bits,
    };
  }
  return {
    video: {
      width,
      height,
      pixelFormat,
      frameRate,
      color: {
        ...(colorTag(video.color_range)
          ? { range: colorTag(video.color_range)! }
          : {}),
        ...(colorTag(video.color_space)
          ? { space: colorTag(video.color_space)! }
          : {}),
        ...(colorTag(video.color_primaries)
          ? { primaries: colorTag(video.color_primaries)! }
          : {}),
        ...(colorTag(video.color_transfer)
          ? { transfer: colorTag(video.color_transfer)! }
          : {}),
      },
    },
    audio,
  };
}

function sameFormat(a: WorkingFormat, b: WorkingFormat): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Exact frame and sample ranges for every clip, in timeline order. */
export function planExport(
  clips: readonly ExportClip[],
  sources: readonly ExportSource[],
): ExportPlan {
  if (clips.length < 1 || clips.length > 4096)
    unsupported("This draft has no exportable clips.");
  const byId = new Map(sources.map((source) => [source.sourceId, source]));
  const formats = new Map<string, WorkingFormat>();
  for (const source of sources)
    formats.set(source.sourceId, workingFormat(source.probe, source.timing));
  const first = formats.get(clips[0]!.sourceId);
  if (!first) unsupported("A clip refers to an unknown source.");
  for (const format of formats.values())
    if (!sameFormat(format, first))
      unsupported(
        "These sources use different video or audio formats. Exporting them together needs a conversion that is not available yet.",
      );
  const planned: PlannedClip[] = [];
  let frameCount = 0;
  let sampleCount = 0;
  for (const clip of clips) {
    const source = byId.get(clip.sourceId);
    if (!source) unsupported("A clip refers to an unknown source.");
    if (
      !Number.isSafeInteger(clip.sourceStartUs) ||
      !Number.isSafeInteger(clip.sourceEndUs) ||
      clip.sourceStartUs < 0 ||
      clip.sourceEndUs <= clip.sourceStartUs ||
      (clip.speed !== undefined &&
        (!Number.isSafeInteger(clip.speed) ||
          clip.speed < 1 ||
          clip.speed > 16))
    )
      unsupported("A clip has an invalid source range.");
    const speed = clip.speed ?? 1;
    // Frame i is presented at exactly i / rate (see nominalFrameRate).
    const fn = BigInt(first.video.frameRate.numerator);
    const fd = BigInt(first.video.frameRate.denominator);
    const frames = source.timing.pts.length;
    const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
    const frameAt = (us: number) =>
      Math.min(frames, Number(ceilDiv(BigInt(us) * fn, fd * 1_000_000n)));
    const firstFrame = frameAt(clip.sourceStartUs);
    const endFrame = frameAt(clip.sourceEndUs);
    const count = endFrame - firstFrame;
    if (count <= 0) continue;
    const frameSeconds = Number(fd) / Number(fn);
    const trimStartSeconds = Math.max(0, (firstFrame - 0.5) * frameSeconds);
    const trimEndSeconds = (endFrame - 0.5) * frameSeconds;
    let firstSample = 0;
    let samples = 0;
    if (first.audio) {
      const rate = BigInt(first.audio.sampleRate);
      const a = ceilDiv(BigInt(firstFrame) * fd * rate, fn);
      const b = ceilDiv(BigInt(endFrame) * fd * rate, fn);
      firstSample = Number(a);
      samples = Number(b - a);
    }
    const outputFrames = Math.ceil(count / speed);
    const outputSamples =
      speed === 1 || !first.audio
        ? samples
        : Number(
            ceilDiv(
              BigInt(outputFrames) * fd * BigInt(first.audio.sampleRate),
              fn,
            ),
          );
    planned.push({
      sourceId: source.sourceId,
      path: source.path,
      firstFrame,
      frameCount: count,
      trimStartSeconds,
      trimEndSeconds,
      seekSeconds: Math.max(0, trimStartSeconds - 2),
      firstSample,
      sampleCount: samples,
      speed,
      outputFrames,
      outputSamples,
    });
    frameCount += outputFrames;
    sampleCount += outputSamples;
  }
  if (frameCount < 1) unsupported("This draft has no exportable frames.");
  return {
    format: first,
    clips: planned,
    frameCount,
    sampleCount,
    frameBytes: rawFrameBytes(
      first.video.pixelFormat,
      first.video.width,
      first.video.height,
    ),
    sourceHashes: Object.fromEntries(
      sources.map((source) => [source.sourceId, source.sha256]),
    ),
  };
}

const quiet = ["-hide_banner", "-loglevel", "error", "-nostdin"];

function seconds6(value: number): string {
  return value.toFixed(6);
}

function startProcess(
  executable: string,
  args: string[],
  stdin: "pipe" | "ignore",
  cwd?: string,
): ChildProcess {
  return spawn(executable, args, {
    shell: false,
    windowsHide: true,
    stdio: [stdin, "pipe", "pipe"],
    ...(cwd ? { cwd } : {}),
  });
}

/** Resolves on exit 0, rejects otherwise; stderr is drained, never surfaced. */
function exited(child: ChildProcess): Promise<void> {
  child.stderr?.resume();
  const result = new Promise<void>((resolvePromise, reject) => {
    child.once("error", () =>
      reject(
        new MediaError(
          "PROCESS_UNAVAILABLE",
          "Media executable could not be started.",
        ),
      ),
    );
    child.once("close", (code) =>
      code === 0
        ? resolvePromise()
        : reject(new MediaError("PROCESS_FAILED", "Media executable failed.")),
    );
  });
  // A process killed by cancellation may fail before anyone awaits it.
  result.catch(() => undefined);
  return result;
}

async function writeChunk(
  target: Writable,
  chunk: Buffer,
  signal?: AbortSignal,
): Promise<void> {
  // A killed reader may never drain or error (seen on Windows pipes), so a
  // pending write must also end when the job stops.
  if (!target.write(chunk))
    await once(target, "drain", signal ? { signal } : undefined);
}

/** Streams a process's stdout into hash and optional sink; returns byte count. */
async function drain(
  source: Readable,
  onChunk: (chunk: Buffer) => Promise<void> | void,
): Promise<void> {
  for await (const chunk of source) await onChunk(chunk as Buffer);
}

function colorArgs(color: WorkingVideoFormat["color"]): string[] {
  return [
    ...(color.range ? ["-color_range", color.range] : []),
    ...(color.space
      ? ["-colorspace", color.space === "gbr" ? "rgb" : color.space]
      : []),
    ...(color.primaries ? ["-color_primaries", color.primaries] : []),
    ...(color.transfer ? ["-color_trc", color.transfer] : []),
  ];
}

function pcmCodec(audio: WorkingAudioFormat): string {
  if (audio.raw === "s32le" && audio.bits === 24) return "pcm_s24le";
  return `pcm_${audio.raw}`;
}

export interface ExportRequest {
  plan: ExportPlan;
  profile: ExportProfile;
  /** Final destination; published only after verification. */
  outputPath: string;
  /** True when the user confirmed replacing an existing file. */
  replace: boolean;
  executables?: MediaExecutables;
  signal?: AbortSignal;
  onProgress?: (progress: ExportProgress) => void;
  /**
   * Advanced SubStation script drawn into the frames (burned-in captions).
   * The composed frames become the canonical render the export verifies.
   */
  overlayAss?: string;
  /**
   * A composition that changes the frame (for example reframing a short),
   * optionally followed by burned-in captions at the new size.
   */
  compose?: ExportComposition;
  /** Speech cleanup applied to the assembled audio before encoding. */
  audioCleanup?: { normalize: boolean; denoise: boolean };
}

export interface ExportComposition {
  /** FFmpeg filtergraph from the draft frames to the composed frames. */
  filter: string;
  ass?: string;
  width: number;
  height: number;
  pixelFormat: string;
  /** Colour description of the composed frames; defaults to the draft's. */
  color?: WorkingVideoFormat["color"];
}

const defaultExecutables: MediaExecutables = {
  ffmpeg: "ffmpeg",
  ffprobe: "ffprobe",
};

/**
 * Speech cleanup on the assembled canonical audio: optional spectral noise
 * reduction, then optional two-pass loudness normalisation (measure, then a
 * linear gain where possible). The result is resampled to the working rate
 * and cut or padded to exactly the planned sample count, so it stays in sync
 * with the frames. The processed audio becomes the canonical audio.
 */
async function cleanAudio(options: {
  ffmpeg: string;
  audio: WorkingAudioFormat;
  audioPath: string;
  staging: string;
  sampleCount: number;
  normalize: boolean;
  denoise: boolean;
  signal?: AbortSignal;
}): Promise<string> {
  const { audio } = options;
  const input = [
    "-f",
    audio.raw,
    "-ar",
    String(audio.sampleRate),
    "-ch_layout",
    audio.channelLayout,
    "-i",
    options.audioPath,
  ];
  const filters: string[] = [];
  if (options.denoise) filters.push("afftdn=nr=12:nf=-50:tn=1");
  if (options.normalize) {
    const target = "I=-16:TP=-1.5:LRA=11";
    const measured = await runProcess({
      executable: options.ffmpeg,
      args: [
        "-hide_banner",
        "-nostdin",
        "-loglevel",
        "info",
        ...input,
        "-af",
        [...filters, `loudnorm=${target}:print_format=json`].join(","),
        "-f",
        "null",
        "-",
      ],
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const text = measured.stderr.toString();
    const json = text.slice(text.lastIndexOf("{"), text.lastIndexOf("}") + 1);
    const values = JSON.parse(json) as Record<string, string>;
    const number = (key: string) => {
      const value = Number(values[key]);
      if (!Number.isFinite(value))
        throw new MediaError("PROCESS_FAILED", "Media executable failed.");
      return value;
    };
    const inputI = number("input_i");
    // Near-silent audio has no meaningful loudness; leave its level alone.
    if (inputI > -70)
      filters.push(
        `loudnorm=${target}:measured_I=${inputI}:measured_TP=${number("input_tp")}:measured_LRA=${number("input_lra")}:measured_thresh=${number("input_thresh")}:offset=${number("target_offset")}:linear=true`,
      );
  }
  filters.push(
    `aresample=${audio.sampleRate}`,
    "apad",
    `atrim=end_sample=${options.sampleCount}`,
  );
  const processed = join(options.staging, "processed-audio.raw");
  await runProcess({
    executable: options.ffmpeg,
    args: [
      ...quiet,
      ...input,
      "-af",
      filters.join(","),
      "-c:a",
      `pcm_${audio.raw}`,
      "-f",
      audio.raw,
      processed,
    ],
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const expected =
    options.sampleCount * rawSampleBytes[audio.raw] * audio.channels;
  if ((await stat(processed)).size !== expected)
    throw new MediaError(
      "FIDELITY_MISMATCH",
      "Cleaned audio does not match the draft length.",
    );
  await rename(processed, options.audioPath);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(options.audioPath))
    hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/**
 * Renders, encodes, verifies and publishes one export. Throws `MediaError`
 * with a fixed message; staging data is removed on every failure.
 */
export async function exportDraft(
  request: ExportRequest,
): Promise<ExportEvidence> {
  const { plan, profile, signal } = request;
  const executables = request.executables ?? defaultExecutables;
  const outputPath = resolve(request.outputPath);
  const extension = extname(outputPath).toLowerCase();
  if (
    (profile === "lossless_master" && extension !== ".mkv") ||
    (profile === "smaller_mp4" && extension !== ".mp4")
  )
    throw new MediaError(
      "INVALID_INPUT",
      "The file extension does not match the chosen export.",
    );
  for (const clip of plan.clips)
    if (resolve(clip.path) === outputPath)
      throw new MediaError("INVALID_INPUT", "Choose a different export file.");
  if (signal?.aborted) throw new MediaError("CANCELLED", "Export cancelled.");
  const { video, audio } = plan.format;
  const children = new Set<ChildProcess>();
  const closed: Promise<void>[] = [];
  const track = (child: ChildProcess) => {
    children.add(child);
    closed.push(
      new Promise<void>((resolveClose) =>
        child.once("close", () => {
          children.delete(child);
          resolveClose();
        }),
      ),
    );
    return child;
  };
  let cancelled = false;
  const halt = new AbortController();
  const cancel = () => {
    cancelled = true;
    halt.abort();
    for (const child of children) child.kill("SIGKILL");
  };
  signal?.addEventListener("abort", cancel, { once: true });
  const staging = join(
    dirname(outputPath),
    `.${basename(outputPath)}.${randomUUID()}.partial`,
  );
  await mkdir(staging, { recursive: false, mode: 0o700 });
  const stagedOutput = join(staging, `export${extension}`);
  const audioPath = join(staging, "canonical-audio.raw");
  const totalWork = plan.frameCount * 2;
  let doneWork = 0;
  const progress = (phase: ExportProgress["phase"], frames: number) => {
    doneWork += frames;
    request.onProgress?.({
      phase,
      fraction: Math.min(1, doneWork / totalWork),
    });
  };
  const fail = (error: unknown): never => {
    if (cancelled || signal?.aborted)
      throw new MediaError("CANCELLED", "Export cancelled.");
    if (error instanceof MediaError) throw error;
    throw new MediaError(
      "PROCESS_FAILED",
      "The export could not be completed.",
    );
  };
  try {
    const version = await runProcess({
      executable: executables.ffmpeg,
      args: ["-version"],
      ...(signal ? { signal } : {}),
    });
    const ffmpegVersion = version.stdout.toString().split(/\r?\n/u)[0] ?? "";

    // 1. Canonical audio: exact source samples for each clip, in order.
    // Each source's audio is decoded once from its start: decoding after a
    // seek does not reproduce identical samples for every codec.
    let canonicalAudioSha256: string | null = null;
    if (audio) {
      const hash = createHash("sha256");
      const sampleBytes = rawSampleBytes[audio.raw] * audio.channels;
      const decodedAudio = new Map<string, { file: string; bytes: number }>();
      for (const clip of plan.clips) {
        if (decodedAudio.has(clip.path)) continue;
        const file = join(staging, `source-audio-${decodedAudio.size}.raw`);
        const child = track(
          startProcess(
            executables.ffmpeg,
            [
              ...quiet,
              "-i",
              clip.path,
              "-map",
              "0:a:0",
              "-c:a",
              `pcm_${audio.raw}`,
              "-f",
              audio.raw,
              file,
            ],
            "ignore",
          ),
        );
        child.stdout?.resume();
        await exited(child);
        decodedAudio.set(clip.path, { file, bytes: (await stat(file)).size });
      }
      /** Copies `length` bytes of `file` from `offset`, chunk by chunk. */
      const copyRange = async (
        file: string,
        offset: number,
        length: number,
        write: (buffer: Buffer) => Promise<void>,
      ) => {
        if (length <= 0) return;
        const handle = await open(file, "r");
        try {
          const chunkSize = 4 * 1024 * 1024;
          for (let done = 0; done < length;) {
            const size = Math.min(chunkSize, length - done);
            const buffer = Buffer.alloc(size);
            const { bytesRead } = await handle.read(
              buffer,
              0,
              size,
              offset + done,
            );
            if (bytesRead !== size)
              throw new MediaError(
                "PROCESS_FAILED",
                "Media executable failed.",
              );
            await write(buffer);
            done += size;
          }
        } finally {
          await handle.close();
        }
      };
      const output = createWriteStream(audioPath, { mode: 0o600 });
      try {
        for (const clip of plan.clips) {
          const source = decodedAudio.get(clip.path)!;
          const offset = clip.firstSample * sampleBytes;
          const expected = clip.sampleCount * sampleBytes;
          const available = Math.max(
            0,
            Math.min(expected, source.bytes - offset),
          );
          // A source whose audio ends before its video contributes silence.
          const silence = Buffer.alloc(expected - available);
          if (clip.speed === 1) {
            const write = async (buffer: Buffer) => {
              hash.update(buffer);
              await writeChunk(output, buffer);
            };
            await copyRange(source.file, offset, available, write);
            if (silence.length) await write(silence);
          } else {
            // Time-stretch the slice without changing pitch, then fix its
            // length to the exact planned sample count.
            const slice = join(staging, "speed-slice.raw");
            const stretched = join(staging, "speed-stretched.raw");
            const sliceStream = createWriteStream(slice, { mode: 0o600 });
            try {
              await copyRange(source.file, offset, available, (buffer) =>
                writeChunk(sliceStream, buffer),
              );
              if (silence.length) await writeChunk(sliceStream, silence);
            } finally {
              sliceStream.end();
              await once(sliceStream, "close");
            }
            await runProcess({
              executable: executables.ffmpeg,
              args: [
                ...quiet,
                "-f",
                audio.raw,
                "-ar",
                String(audio.sampleRate),
                "-ch_layout",
                audio.channelLayout,
                "-i",
                slice,
                "-af",
                `${atempoChain(clip.speed)},apad,atrim=end_sample=${clip.outputSamples}`,
                "-c:a",
                `pcm_${audio.raw}`,
                "-f",
                audio.raw,
                stretched,
              ],
              ...(signal ? { signal } : {}),
            });
            const length = clip.outputSamples * sampleBytes;
            if ((await stat(stretched)).size !== length)
              throw new MediaError(
                "FIDELITY_MISMATCH",
                "Sped-up audio does not match the draft length.",
              );
            await copyRange(stretched, 0, length, async (buffer) => {
              hash.update(buffer);
              await writeChunk(output, buffer);
            });
            await rm(slice, { force: true });
            await rm(stretched, { force: true });
          }
          if (signal?.aborted)
            throw new MediaError("CANCELLED", "Export cancelled.");
        }
      } finally {
        output.end();
        await once(output, "close");
      }
      for (const source of decodedAudio.values())
        await rm(source.file, { force: true });
      canonicalAudioSha256 = hash.digest("hex");
      const cleanup = request.audioCleanup;
      if (cleanup && (cleanup.normalize || cleanup.denoise)) {
        canonicalAudioSha256 = await cleanAudio({
          ffmpeg: executables.ffmpeg,
          audio,
          audioPath,
          staging,
          sampleCount: plan.sampleCount,
          normalize: cleanup.normalize,
          denoise: cleanup.denoise,
          ...(signal ? { signal } : {}),
        });
      }
    }

    // 2. Canonical video frames streamed straight into the encoder.
    const composition: ExportComposition | null =
      request.compose ??
      (request.overlayAss !== undefined
        ? {
            filter: "",
            ass: request.overlayAss,
            width: video.width,
            height: video.height,
            pixelFormat: video.pixelFormat,
          }
        : null);
    const target = composition
      ? {
          width: composition.width,
          height: composition.height,
          pixelFormat: composition.pixelFormat,
          frameBytes: rawFrameBytes(
            composition.pixelFormat,
            composition.width,
            composition.height,
          ),
          color: composition.color ?? video.color,
        }
      : {
          width: video.width,
          height: video.height,
          pixelFormat: video.pixelFormat,
          frameBytes: plan.frameBytes,
          color: video.color,
        };
    const encoderArgs = [
      ...quiet,
      "-f",
      "rawvideo",
      "-pixel_format",
      target.pixelFormat,
      "-video_size",
      `${target.width}x${target.height}`,
      "-framerate",
      `${video.frameRate.numerator}/${video.frameRate.denominator}`,
      ...colorArgs(target.color),
      "-i",
      "pipe:0",
      ...(audio
        ? [
            "-f",
            audio.raw,
            "-ar",
            String(audio.sampleRate),
            "-ch_layout",
            audio.channelLayout,
            "-i",
            audioPath,
          ]
        : []),
      "-map",
      "0:v:0",
      ...(audio ? ["-map", "1:a:0"] : []),
      "-map_metadata",
      "-1",
      ...(profile === "lossless_master"
        ? [
            "-c:v",
            "ffv1",
            "-level",
            "3",
            "-coder",
            "1",
            "-context",
            "1",
            "-g",
            "1",
            "-slicecrc",
            "1",
            "-pix_fmt",
            `+${target.pixelFormat}`,
            "-fps_mode",
            "passthrough",
            ...colorArgs(target.color),
            ...(audio ? ["-c:a", pcmCodec(audio)] : []),
            // Deterministic muxing: identical renders give identical files.
            "-fflags",
            "+bitexact",
            "-f",
            "matroska",
          ]
        : [
            "-c:v",
            "libx264",
            "-preset",
            "medium",
            "-crf",
            "18",
            "-pix_fmt",
            "yuv420p",
            ...colorArgs(target.color),
            ...(audio ? ["-c:a", "aac", "-b:a", "192k"] : []),
            "-movflags",
            "+faststart",
            "-f",
            "mp4",
          ]),
      stagedOutput,
    ];
    const encoder = track(
      startProcess(executables.ffmpeg, encoderArgs, "pipe"),
    );
    encoder.once("close", () => halt.abort());
    const encoded = exited(encoder);
    encoder.stdout?.resume();
    encoder.stdin!.on("error", () => undefined);
    const videoHash = createHash("sha256");
    // With a composition, decoded frames pass through one compositor that draws
    // the script in the frames' own pixel format; frames it does not touch
    // stay bit-identical. Its output is what is hashed and encoded.
    let compositor: ChildProcess | null = null;
    let composed: Promise<number> | null = null;
    if (composition) {
      if (composition.ass !== undefined)
        await writeFile(join(staging, "overlay.ass"), composition.ass, {
          mode: 0o600,
        });
      const graph = [
        composition.filter ? `[0:v]${composition.filter}[framed]` : null,
        `[${composition.filter ? "framed" : "0:v"}]${
          composition.ass !== undefined ? "ass=overlay.ass," : ""
        }${
          target.pixelFormat.startsWith("yuv") &&
          !video.pixelFormat.startsWith("yuv")
            ? "scale=out_color_matrix=bt709:out_range=tv,"
            : ""
        }format=${target.pixelFormat}[out]`,
      ]
        .filter(Boolean)
        .join(";");
      const child = track(
        startProcess(
          executables.ffmpeg,
          [
            ...quiet,
            "-f",
            "rawvideo",
            "-pixel_format",
            video.pixelFormat,
            "-video_size",
            `${video.width}x${video.height}`,
            "-framerate",
            `${video.frameRate.numerator}/${video.frameRate.denominator}`,
            "-i",
            "pipe:0",
            // A relative name avoids filter-argument escaping of full paths.
            "-filter_complex",
            graph,
            "-map",
            "[out]",
            "-fps_mode",
            "passthrough",
            "-c:v",
            "rawvideo",
            "-pix_fmt",
            target.pixelFormat,
            "-f",
            "rawvideo",
            "pipe:1",
          ],
          "pipe",
          staging,
        ),
      );
      child.stdin!.on("error", () => undefined);
      compositor = child;
      const done = exited(child);
      composed = (async () => {
        let bytes = 0;
        let reported = 0;
        await drain(child.stdout!, async (chunk) => {
          bytes += chunk.length;
          videoHash.update(chunk);
          await writeChunk(encoder.stdin!, chunk, halt.signal);
          const frames = Math.floor(bytes / target.frameBytes);
          if (frames > reported) {
            progress("rendering", frames - reported);
            reported = frames;
          }
        });
        await done;
        return bytes;
      })();
      composed.catch(() => undefined);
    }
    const sink = compositor ? compositor.stdin! : encoder.stdin!;
    try {
      for (const clip of plan.clips) {
        const expected = clip.frameCount * plan.frameBytes;
        const child = track(
          startProcess(
            executables.ffmpeg,
            [
              ...quiet,
              "-copyts",
              "-ss",
              seconds6(clip.seekSeconds),
              "-i",
              clip.path,
              "-map",
              "0:v:0",
              "-vf",
              `trim=start=${seconds6(clip.trimStartSeconds)}:end=${seconds6(clip.trimEndSeconds)}`,
              "-frames:v",
              String(clip.frameCount),
              "-fps_mode",
              "passthrough",
              "-c:v",
              "rawvideo",
              "-pix_fmt",
              video.pixelFormat,
              "-f",
              "rawvideo",
              "pipe:1",
            ],
            "ignore",
          ),
        );
        const done = exited(child);
        let written = 0;
        let kept = 0;
        let reported = 0;
        await drain(child.stdout!, async (chunk) => {
          const start = written;
          written += chunk.length;
          if (written > expected) return;
          // A sped-up clip keeps every `speed`-th decoded frame.
          const parts: Buffer[] = [];
          if (clip.speed === 1) parts.push(chunk);
          else
            for (let at = start; at < written;) {
              const frame = Math.floor(at / plan.frameBytes);
              const frameEnd = (frame + 1) * plan.frameBytes;
              const until = Math.min(frameEnd, written);
              if (frame % clip.speed === 0)
                parts.push(chunk.subarray(at - start, until - start));
              at = until;
            }
          for (const part of parts) {
            kept += part.length;
            if (!compositor) videoHash.update(part);
            await writeChunk(sink, part, halt.signal);
          }
          if (compositor) return;
          const frames = Math.floor(kept / plan.frameBytes);
          if (frames > reported) {
            progress("rendering", frames - reported);
            reported = frames;
          }
        });
        await done;
        if (
          written !== expected ||
          kept !== clip.outputFrames * plan.frameBytes
        )
          throw new MediaError(
            "FIDELITY_MISMATCH",
            "A clip did not decode to its exact frame range.",
          );
      }
      if (compositor && composed) {
        compositor.stdin!.end();
        if ((await composed) !== plan.frameCount * target.frameBytes)
          throw new MediaError(
            "FIDELITY_MISMATCH",
            "The overlay did not return every rendered frame.",
          );
      }
    } finally {
      compositor?.stdin?.end();
      encoder.stdin!.end();
    }
    await encoded;
    const canonicalVideoSha256 = videoHash.digest("hex");

    // 3. Verify stream metadata and decoded samples.
    const probe = JSON.parse(
      (
        await runProcess({
          executable: executables.ffprobe,
          args: [
            "-v",
            "error",
            "-show_streams",
            "-show_format",
            "-of",
            "json",
            stagedOutput,
          ],
          ...(signal ? { signal } : {}),
        })
      ).stdout.toString(),
    ) as { streams?: Record<string, unknown>[] };
    const outStreams = probe.streams ?? [];
    const outVideo = outStreams.find((stream) => stream.codec_type === "video");
    const outAudio = outStreams.find((stream) => stream.codec_type === "audio");
    const expectedVideoCodec = profile === "lossless_master" ? "ffv1" : "h264";
    if (
      !outVideo ||
      outStreams.length !== (audio ? 2 : 1) ||
      (audio && !outAudio) ||
      outVideo.codec_name !== expectedVideoCodec ||
      outVideo.width !== target.width ||
      outVideo.height !== target.height ||
      (profile === "lossless_master" &&
        (outVideo.pix_fmt !== target.pixelFormat ||
          (target.color.range !== undefined &&
            outVideo.color_range !== target.color.range) ||
          (target.color.space !== undefined &&
            outVideo.color_space !== target.color.space) ||
          (target.color.primaries !== undefined &&
            outVideo.color_primaries !== target.color.primaries) ||
          (target.color.transfer !== undefined &&
            outVideo.color_transfer !== target.color.transfer))) ||
      (audio &&
        (Number(outAudio!.sample_rate) !== audio.sampleRate ||
          Number(outAudio!.channels) !== audio.channels ||
          (profile === "lossless_master" &&
            outAudio!.codec_name !== pcmCodec(audio))))
    )
      throw new MediaError(
        "FIDELITY_MISMATCH",
        "The exported file's streams differ from the draft's format.",
      );
    const decodeVideo = track(
      startProcess(
        executables.ffmpeg,
        [
          ...quiet,
          "-i",
          stagedOutput,
          "-map",
          "0:v:0",
          "-fps_mode",
          "passthrough",
          "-c:v",
          "rawvideo",
          "-pix_fmt",
          profile === "lossless_master" ? target.pixelFormat : "yuv420p",
          "-f",
          "rawvideo",
          "pipe:1",
        ],
        "ignore",
      ),
    );
    const decodedVideoDone = exited(decodeVideo);
    const decodedVideoHash = createHash("sha256");
    const decodedFrameBytes =
      profile === "lossless_master"
        ? target.frameBytes
        : rawFrameBytes("yuv420p", target.width, target.height);
    let decodedBytes = 0;
    let verifiedFrames = 0;
    await drain(decodeVideo.stdout!, (chunk) => {
      decodedBytes += chunk.length;
      decodedVideoHash.update(chunk);
      const frames = Math.floor(decodedBytes / decodedFrameBytes);
      if (frames > verifiedFrames) {
        progress("verifying", frames - verifiedFrames);
        verifiedFrames = frames;
      }
    });
    await decodedVideoDone;
    const decodedVideoSha256 = decodedVideoHash.digest("hex");
    if (decodedBytes !== plan.frameCount * decodedFrameBytes)
      throw new MediaError(
        "FIDELITY_MISMATCH",
        "The exported file does not contain every rendered frame.",
      );
    let decodedAudioSha256: string | null = null;
    if (audio) {
      const decodeAudio = track(
        startProcess(
          executables.ffmpeg,
          [
            ...quiet,
            "-i",
            stagedOutput,
            "-map",
            "0:a:0",
            "-c:a",
            `pcm_${audio.raw}`,
            "-f",
            audio.raw,
            "pipe:1",
          ],
          "ignore",
        ),
      );
      const done = exited(decodeAudio);
      const hash = createHash("sha256");
      let bytes = 0;
      await drain(decodeAudio.stdout!, (chunk) => {
        bytes += chunk.length;
        hash.update(chunk);
      });
      await done;
      decodedAudioSha256 = hash.digest("hex");
      const expected =
        plan.sampleCount * rawSampleBytes[audio.raw] * audio.channels;
      // Lossy audio adds encoder delay/padding; only the master must match exactly.
      if (profile === "lossless_master" && bytes !== expected)
        throw new MediaError(
          "FIDELITY_MISMATCH",
          "The exported file does not contain every rendered audio sample.",
        );
    }
    const samplesEqual =
      decodedVideoSha256 === canonicalVideoSha256 &&
      decodedAudioSha256 === canonicalAudioSha256;
    if (profile === "lossless_master" && !samplesEqual)
      throw new MediaError(
        "FIDELITY_MISMATCH",
        "The exported master does not decode to the rendered frames and samples.",
      );

    // 4. Sources must be unchanged, then hash and publish the output.
    for (const [sourceId, expected] of Object.entries(plan.sourceHashes)) {
      const clip = plan.clips.find((item) => item.sourceId === sourceId);
      if (!clip) continue;
      const hash = createHash("sha256");
      const handle = await open(clip.path, "r");
      try {
        for await (const chunk of handle.createReadStream())
          hash.update(chunk as Buffer);
      } finally {
        await handle.close().catch(() => undefined);
      }
      if (hash.digest("hex") !== expected)
        throw new MediaError(
          "FIDELITY_MISMATCH",
          "A source changed during export.",
        );
    }
    const outputHash = createHash("sha256");
    const output = await open(stagedOutput, "r");
    try {
      for await (const chunk of output.createReadStream())
        outputHash.update(chunk as Buffer);
    } finally {
      await output.close().catch(() => undefined);
    }
    const outputBytes = (await stat(stagedOutput)).size;
    if (signal?.aborted) throw new MediaError("CANCELLED", "Export cancelled.");
    if (request.replace) await rename(stagedOutput, outputPath);
    else await publishFileWithoutOverwrite(stagedOutput, outputPath, signal);
    const durationUs = Number(
      (BigInt(plan.frameCount) *
        BigInt(video.frameRate.denominator) *
        1_000_000n) /
        BigInt(video.frameRate.numerator),
    );
    return {
      profile,
      ffmpegVersion,
      outputSha256: outputHash.digest("hex"),
      outputBytes,
      frameCount: plan.frameCount,
      audioSampleCount: plan.sampleCount,
      durationUs,
      canonicalVideoSha256,
      canonicalAudioSha256,
      samplesEqual,
      decodedVideoSha256,
      decodedAudioSha256,
      sourceHashesUnchanged: true,
      format: plan.format,
      container: profile === "lossless_master" ? "matroska" : "mp4",
      videoCodec: expectedVideoCodec,
      audioCodec: audio
        ? profile === "lossless_master"
          ? pcmCodec(audio)
          : "aac"
        : null,
    };
  } catch (error) {
    return fail(error);
  } finally {
    halt.abort();
    signal?.removeEventListener("abort", cancel);
    for (const child of children) child.kill("SIGKILL");
    // Windows keeps a killed process's files open until it has exited.
    await Promise.race([
      Promise.all(closed),
      new Promise((resolveWait) => setTimeout(resolveWait, 10_000)),
    ]);
    await rm(staging, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 100,
    }).catch(() => undefined);
  }
}
