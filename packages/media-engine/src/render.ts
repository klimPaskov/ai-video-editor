import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { once } from "node:events";
import type { Readable, Writable } from "node:stream";
import { MediaError, runProcess } from "./process.ts";
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
  if (timing.variableCadence || timing.pts.length < 1)
    unsupported("Variable frame rate video cannot be exported yet.");
  const frameTicks =
    timing.pts.length > 1
      ? timing.pts[1]! - timing.pts[0]!
      : timing.lastDurationTicks;
  if (!frameTicks || frameTicks <= 0)
    unsupported("This video's frame timing cannot be verified.");
  // fps = den / (num * ticks)
  const n = BigInt(timing.timeBaseDenominator);
  const d = BigInt(timing.timeBaseNumerator) * BigInt(frameTicks);
  const g = gcd(n, d);
  const frameRate = { numerator: Number(n / g), denominator: Number(d / g) };
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
      clip.sourceEndUs <= clip.sourceStartUs
    )
      unsupported("A clip has an invalid source range.");
    const {
      pts,
      timeBaseNumerator: num,
      timeBaseDenominator: den,
    } = source.timing;
    const scale = BigInt(num) * 1_000_000n;
    const atOrAfter = (us: number) => {
      // First frame index whose presentation time is >= us.
      const target = BigInt(us) * BigInt(den);
      let low = 0;
      let high = pts.length;
      while (low < high) {
        const middle = (low + high) >> 1;
        if (BigInt(pts[middle]!) * scale >= target) high = middle;
        else low = middle + 1;
      }
      return low;
    };
    const firstFrame = atOrAfter(clip.sourceStartUs);
    const endFrame = atOrAfter(clip.sourceEndUs);
    const count = endFrame - firstFrame;
    if (count <= 0) continue;
    const frameTicks =
      pts.length > 1 ? pts[1]! - pts[0]! : source.timing.lastDurationTicks!;
    const startTicks = BigInt(pts[firstFrame]!);
    const endTicks =
      endFrame < pts.length
        ? BigInt(pts[endFrame]!)
        : BigInt(pts[pts.length - 1]!) + BigInt(frameTicks);
    const seconds = (ticks: bigint) =>
      Number(ticks * BigInt(num)) / Number(den);
    const half = (frameTicks * num) / den / 2;
    const trimStartSeconds = Math.max(0, seconds(startTicks) - half);
    const trimEndSeconds = seconds(endTicks) - half;
    let firstSample = 0;
    let samples = 0;
    if (first.audio) {
      const rate = BigInt(first.audio.sampleRate);
      const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
      const a = ceilDiv(startTicks * BigInt(num) * rate, BigInt(den));
      const b = ceilDiv(endTicks * BigInt(num) * rate, BigInt(den));
      firstSample = Number(a);
      samples = Number(b - a);
    }
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
    });
    frameCount += count;
    sampleCount += samples;
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
): ChildProcess {
  return spawn(executable, args, {
    shell: false,
    windowsHide: true,
    stdio: [stdin, "pipe", "pipe"],
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

async function writeChunk(target: Writable, chunk: Buffer): Promise<void> {
  if (!target.write(chunk)) await once(target, "drain");
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
}

const defaultExecutables: MediaExecutables = {
  ffmpeg: "ffmpeg",
  ffprobe: "ffprobe",
};

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
  const track = (child: ChildProcess) => {
    children.add(child);
    child.once("close", () => children.delete(child));
    return child;
  };
  let cancelled = false;
  const cancel = () => {
    cancelled = true;
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
          if (available > 0) {
            const handle = await open(source.file, "r");
            try {
              const chunkSize = 4 * 1024 * 1024;
              for (let done = 0; done < available;) {
                const size = Math.min(chunkSize, available - done);
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
                hash.update(buffer);
                await writeChunk(output, buffer);
                done += size;
              }
            } finally {
              await handle.close();
            }
          }
          // A source whose audio ends before its video contributes silence.
          if (available < expected) {
            const silence = Buffer.alloc(expected - available);
            hash.update(silence);
            await writeChunk(output, silence);
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
    }

    // 2. Canonical video frames streamed straight into the encoder.
    const encoderArgs = [
      ...quiet,
      "-f",
      "rawvideo",
      "-pixel_format",
      video.pixelFormat,
      "-video_size",
      `${video.width}x${video.height}`,
      "-framerate",
      `${video.frameRate.numerator}/${video.frameRate.denominator}`,
      ...colorArgs(video.color),
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
            `+${video.pixelFormat}`,
            "-fps_mode",
            "passthrough",
            ...colorArgs(video.color),
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
            ...colorArgs(video.color),
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
    const encoded = exited(encoder);
    encoder.stdout?.resume();
    encoder.stdin!.on("error", () => undefined);
    const videoHash = createHash("sha256");
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
        let reported = 0;
        await drain(child.stdout!, async (chunk) => {
          written += chunk.length;
          if (written > expected) return;
          videoHash.update(chunk);
          await writeChunk(encoder.stdin!, chunk);
          const frames = Math.floor(written / plan.frameBytes);
          if (frames > reported) {
            progress("rendering", frames - reported);
            reported = frames;
          }
        });
        await done;
        if (written !== expected)
          throw new MediaError(
            "FIDELITY_MISMATCH",
            "A clip did not decode to its exact frame range.",
          );
      }
    } finally {
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
      outVideo.width !== video.width ||
      outVideo.height !== video.height ||
      (profile === "lossless_master" &&
        (outVideo.pix_fmt !== video.pixelFormat ||
          (video.color.range !== undefined &&
            outVideo.color_range !== video.color.range) ||
          (video.color.space !== undefined &&
            outVideo.color_space !== video.color.space) ||
          (video.color.primaries !== undefined &&
            outVideo.color_primaries !== video.color.primaries) ||
          (video.color.transfer !== undefined &&
            outVideo.color_transfer !== video.color.transfer))) ||
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
          profile === "lossless_master" ? video.pixelFormat : "yuv420p",
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
        ? plan.frameBytes
        : rawFrameBytes("yuv420p", video.width, video.height);
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
    signal?.removeEventListener("abort", cancel);
    for (const child of children) child.kill("SIGKILL");
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}
