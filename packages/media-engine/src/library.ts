import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { isDeepStrictEqual } from "node:util";
import {
  assertFrameRequest,
  assertMediaFrame,
  assertMediaList,
  assertMediaSummary,
  maxFramePixels,
  mediaIdPattern,
} from "../../domain/src/library.ts";
import type { MediaFrame, MediaSummary } from "../../domain/src/library.ts";
import { assertNotCancelled, publishFileWithoutOverwrite } from "./files.ts";
import { MediaError, runProcess } from "./process.ts";
import {
  presentationSeekUs,
  probePresentationTiming,
} from "./presentation-timing.ts";
import type { PresentationTiming } from "./presentation-timing.ts";
import { extractSpeechAudioProxy } from "./transcription.ts";
import type { SpeechAudioProxyResult } from "./transcription.ts";

interface Entry {
  version: 1;
  summary: MediaSummary;
  source: { file: string; originalPath: string; sha256: string; size: number };
  probe: Record<string, unknown>;
}
/** Main-process-only source contract. Never expose these paths or probe data through preload. */
export interface VerifiedLibrarySource {
  summary: MediaSummary;
  originalPath: string;
  managedPath: string;
  sha256: string;
  sizeBytes: number;
  probe: Record<string, unknown>;
}
export interface VerifiedPresentationTiming {
  timeBaseNumerator: number;
  timeBaseDenominator: number;
  firstPts: 0;
  lastPts: number;
  lastDurationTicks: number;
  frameCount: number;
  presentationEndUs: number;
  variableCadence: boolean;
}
function invalid(): never {
  throw new MediaError(
    "INVALID_INPUT",
    "The local media library is invalid or unavailable.",
  );
}
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
async function regular(path: string): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) invalid();
}
async function hash(path: string, signal?: AbortSignal): Promise<string> {
  assertNotCancelled(signal);
  const digest = createHash("sha256");
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW || 0),
  );
  for await (const chunk of handle.createReadStream()) {
    assertNotCancelled(signal);
    digest.update(chunk as Buffer);
  }
  return digest.digest("hex");
}
type PreviewProfile = "native-bgra" | "h264-yuv420p";
function previewProfile(
  probe: Record<string, unknown>,
  width: number,
  height: number,
): PreviewProfile | undefined {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    width * height > maxFramePixels ||
    width > 8192 ||
    height > 8192 ||
    probe.color_primaries !== "bt709" ||
    probe.color_transfer !== "bt709"
  )
    return undefined;
  if (
    probe.pix_fmt === "bgra" &&
    probe.color_range === "pc" &&
    probe.color_space === "gbr"
  )
    return "native-bgra";
  // This conversion is only for the 8-bit display transport. Canonical
  // rendering and master export must read the preserved YUV source instead.
  if (
    probe.codec_name !== "h264" ||
    probe.pix_fmt !== "yuv420p" ||
    probe.color_range !== "tv" ||
    probe.color_space !== "bt709" ||
    probe.sample_aspect_ratio !== "1:1" ||
    (object(probe.tags) &&
      probe.tags.rotate !== undefined &&
      probe.tags.rotate !== "0") ||
    (Array.isArray(probe.side_data_list) &&
      probe.side_data_list.some(
        (item: unknown) =>
          object(item) && item.side_data_type === "Display Matrix",
      ))
  )
    return undefined;
  return "h264-yuv420p";
}
export function mediaMeasurements(
  probe: Record<string, unknown>,
): Omit<MediaSummary, "id" | "name"> {
  if (!Array.isArray(probe.streams) || !object(probe.format)) invalid();
  const video: unknown = probe.streams.find(
    (stream: unknown) => object(stream) && stream.codec_type === "video",
  );
  if (!object(video))
    throw new MediaError(
      "UNSUPPORTED_PROFILE",
      "Choose a file containing a video stream.",
    );
  const rate = String(video.avg_frame_rate).split("/").map(Number);
  const width = Number(video.width),
    height = Number(video.height);
  return {
    width,
    height,
    durationUs: Math.round(
      Number(video.duration ?? probe.format.duration) * 1_000_000,
    ),
    frameRate: Number(rate[0]) / Number(rate[1]),
    previewAvailable: previewProfile(video, width, height) !== undefined,
  };
}
function validateEntry(value: unknown): asserts value is Entry {
  if (
    !object(value) ||
    value.version !== 1 ||
    Object.keys(value).sort().join() !== "probe,source,summary,version" ||
    !object(value.source) ||
    !object(value.probe)
  )
    invalid();
  assertMediaSummary(value.summary);
  const expected = mediaMeasurements(value.probe);
  for (const field of [
    "width",
    "height",
    "durationUs",
    "frameRate",
    "previewAvailable",
  ] as const)
    if (value.summary[field] !== expected[field]) invalid();
  const source = value.source;
  if (
    Object.keys(source).sort().join() !== "file,originalPath,sha256,size" ||
    source.file !== `${value.summary.id}.media` ||
    typeof source.originalPath !== "string" ||
    !isAbsolute(source.originalPath) ||
    typeof source.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(source.sha256) ||
    typeof source.size !== "number" ||
    !Number.isSafeInteger(source.size) ||
    source.size <= 0
  )
    invalid();
}

/** Append-only, local ingestion records. This is not a project or a draft timeline. */
export class MediaLibrary {
  private readonly root: string;
  private readonly ffmpeg: string;
  private readonly ffprobe: string;
  private readonly presentationTimings = new Map<
    string,
    Promise<PresentationTiming>
  >();
  constructor(
    root: string,
    options: { ffmpeg?: string; ffprobe?: string } = {},
  ) {
    this.root = resolve(root);
    this.ffmpeg = options.ffmpeg ?? "ffmpeg";
    this.ffprobe = options.ffprobe ?? "ffprobe";
  }
  private async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    if (
      (await lstat(this.root)).isSymbolicLink() ||
      resolve(await realpath(this.root)) !== this.root
    )
      invalid();
    for (const name of ["assets", "index"]) {
      const path = join(this.root, name);
      await mkdir(path, { recursive: true });
      const stat = await lstat(path);
      if (!stat.isDirectory() || stat.isSymbolicLink()) invalid();
    }
  }
  private async entry(id: string): Promise<Entry> {
    if (!mediaIdPattern.test(id)) invalid();
    const path = join(this.root, "index", `${id}.json`);
    await regular(path);
    if ((await lstat(path)).size > 4 * 1024 * 1024) invalid();
    const entry: unknown = JSON.parse(await readFile(path, "utf8"));
    validateEntry(entry);
    if (entry.summary.id !== id) invalid();
    await regular(join(this.root, "assets", entry.source.file));
    return entry;
  }
  async list(): Promise<MediaSummary[]> {
    await this.initialize();
    const files = await readdir(join(this.root, "index"));
    if (files.length > 10_000) invalid();
    const result: MediaSummary[] = [];
    for (const file of files.sort()) {
      if (!file.endsWith(".json") || !mediaIdPattern.test(file.slice(0, -5)))
        invalid();
      result.push((await this.entry(file.slice(0, -5))).summary);
    }
    assertMediaList(result);
    return result;
  }
  async verifiedSource(id: string): Promise<VerifiedLibrarySource> {
    await this.initialize();
    const entry = await this.entry(id);
    const managedPath = join(this.root, "assets", entry.source.file);
    const stat = await lstat(managedPath);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      stat.size !== entry.source.size ||
      (await hash(managedPath)) !== entry.source.sha256
    )
      throw new MediaError(
        "FIDELITY_MISMATCH",
        "The managed source has changed.",
      );
    const result = await runProcess({
      executable: this.ffprobe,
      args: [
        "-v",
        "error",
        "-protocol_whitelist",
        "file",
        "-format_whitelist",
        "matroska,webm,mov,avi",
        "-show_streams",
        "-show_format",
        "-of",
        "json",
        managedPath,
      ],
    });
    const measuredProbe: unknown = JSON.parse(result.stdout.toString("utf8"));
    if (!isDeepStrictEqual(measuredProbe, entry.probe))
      throw new MediaError(
        "FIDELITY_MISMATCH",
        "The stored source measurements no longer match the media.",
      );
    const afterHash = await hash(managedPath);
    const after = await lstat(managedPath);
    if (
      !after.isFile() ||
      after.isSymbolicLink() ||
      after.nlink !== 1 ||
      after.size !== stat.size ||
      after.dev !== stat.dev ||
      after.ino !== stat.ino ||
      after.mtimeMs !== stat.mtimeMs ||
      after.ctimeMs !== stat.ctimeMs ||
      afterHash !== entry.source.sha256
    )
      throw new MediaError(
        "FIDELITY_MISMATCH",
        "The managed source changed during verification.",
      );
    return {
      summary: { ...entry.summary },
      originalPath: entry.source.originalPath,
      managedPath,
      sha256: entry.source.sha256,
      sizeBytes: entry.source.size,
      probe: structuredClone(entry.probe),
    };
  }
  async prepareSpeechAudio(
    id: string,
    outputPath: string,
    signal?: AbortSignal,
  ): Promise<{
    source: VerifiedLibrarySource;
    audioStreamIndex: number;
    sourceStartUs: number;
    proxy: SpeechAudioProxyResult;
  }> {
    const source = await this.verifiedSource(id);
    const audio = Array.isArray(source.probe.streams)
      ? source.probe.streams
          .filter(
            (stream: unknown) =>
              object(stream) && stream.codec_type === "audio",
          )
          .sort(
            (left: unknown, right: unknown) =>
              (object(left) ? Number(left.index) : Number.NaN) -
              (object(right) ? Number(right.index) : Number.NaN),
          )[0]
      : undefined;
    if (!object(audio) || !Number.isSafeInteger(audio.index))
      throw new MediaError(
        "UNSUPPORTED_PROFILE",
        "This source has no audio track to transcribe.",
      );
    const startSeconds = Number(audio.start_time ?? 0);
    const sourceStartUs = Math.round(startSeconds * 1_000_000);
    if (
      !Number.isFinite(startSeconds) ||
      sourceStartUs < 0 ||
      sourceStartUs >= source.summary.durationUs
    )
      throw new MediaError(
        "UNSUPPORTED_PROFILE",
        "This source's audio timing needs a supported synchronization profile.",
      );
    const proxy = await extractSpeechAudioProxy({
      ffmpegExecutable: this.ffmpeg,
      sourcePath: source.managedPath,
      outputPath,
      audioStreamIndex: audio.index as number,
      sourceStartUs,
      sourceDurationUs: source.summary.durationUs,
      ...(signal ? { signal } : {}),
    });
    const after = await this.verifiedSource(id);
    if (
      after.sha256 !== source.sha256 ||
      after.managedPath !== source.managedPath
    )
      throw new MediaError(
        "FIDELITY_MISMATCH",
        "The managed source has changed.",
      );
    return {
      source,
      audioStreamIndex: audio.index as number,
      sourceStartUs,
      proxy,
    };
  }
  /** Main-only timing evidence for a future multi-source baseline; never a render proxy. */
  async verifiedPresentationTiming(
    id: string,
  ): Promise<VerifiedPresentationTiming> {
    const source = await this.verifiedSource(id);
    const video = source.probe.streams;
    const stream = Array.isArray(video)
      ? video.find(
          (item: unknown) => object(item) && item.codec_type === "video",
        )
      : undefined;
    if (!object(stream)) invalid();
    const timing = await probePresentationTiming(
      this.ffprobe,
      source.managedPath,
      stream,
    );
    if (
      timing.lastDurationTicks === null ||
      timing.presentationEndUs === null ||
      (await hash(source.managedPath)) !== source.sha256
    )
      throw new MediaError(
        "UNSUPPORTED_PROFILE",
        "The final displayed frame duration cannot be verified for this source.",
      );
    return {
      timeBaseNumerator: timing.timeBaseNumerator,
      timeBaseDenominator: timing.timeBaseDenominator,
      firstPts: 0,
      lastPts: timing.pts.at(-1)!,
      lastDurationTicks: timing.lastDurationTicks,
      frameCount: timing.pts.length,
      presentationEndUs: timing.presentationEndUs,
      variableCadence: timing.variableCadence,
    };
  }
  async importFile(
    sourcePath: string,
    signal?: AbortSignal,
  ): Promise<MediaSummary> {
    await this.initialize();
    assertNotCancelled(signal);
    if (!isAbsolute(sourcePath)) invalid();
    await regular(sourcePath);
    const size = (await lstat(sourcePath)).size;
    if (size <= 0 || size > 100 * 1024 ** 3) invalid();
    const originalHash = await hash(sourcePath, signal);
    const id = randomUUID();
    const file = `${id}.media`;
    const target = join(this.root, "assets", file);
    const sourceHandle = await open(
      sourcePath,
      constants.O_RDONLY | (constants.O_NOFOLLOW || 0),
    );
    try {
      const destination = await open(target, "wx", 0o600);
      await pipeline(
        sourceHandle.createReadStream(),
        destination.createWriteStream(),
        signal ? { signal } : {},
      );
    } finally {
      await sourceHandle.close();
    }
    assertNotCancelled(signal);
    if (
      (await hash(target, signal)) !== originalHash ||
      (await hash(sourcePath, signal)) !== originalHash
    )
      throw new MediaError(
        "FIDELITY_MISMATCH",
        "Source changed during import; no media was indexed.",
      );
    const result = await runProcess({
      executable: this.ffprobe,
      args: [
        "-v",
        "error",
        "-protocol_whitelist",
        "file",
        "-format_whitelist",
        "matroska,webm,mov,avi",
        "-show_streams",
        "-show_format",
        "-of",
        "json",
        target,
      ],
      ...(signal ? { signal } : {}),
    });
    const probe: unknown = JSON.parse(result.stdout.toString("utf8"));
    if (
      !object(probe) ||
      !Array.isArray(probe.streams) ||
      !object(probe.format)
    )
      invalid();
    const summary: MediaSummary = {
      id,
      name: basename(sourcePath),
      ...mediaMeasurements(probe),
    };
    assertMediaSummary(summary);
    if ((await hash(sourcePath, signal)) !== originalHash)
      throw new MediaError(
        "FIDELITY_MISMATCH",
        "Source changed during import; no media was indexed.",
      );
    const entry: Entry = {
      version: 1,
      summary,
      source: { file, originalPath: sourcePath, sha256: originalHash, size },
      probe,
    };
    const staged = join(this.root, "assets", `${id}.index-stage`);
    await writeFile(staged, JSON.stringify(entry), { flag: "wx", mode: 0o600 });
    await publishFileWithoutOverwrite(
      staged,
      join(this.root, "index", `${id}.json`),
      signal,
    );
    return summary;
  }
  async frame(
    id: string,
    timeUs: number,
    signal?: AbortSignal,
  ): Promise<MediaFrame> {
    assertFrameRequest({ id, timeUs });
    await this.initialize();
    const entry = await this.entry(id);
    const { summary } = entry;
    const streams = entry.probe.streams;
    const video: unknown = Array.isArray(streams)
      ? streams.find(
          (item: unknown) => object(item) && item.codec_type === "video",
        )
      : undefined;
    const profile = object(video)
      ? previewProfile(video, summary.width, summary.height)
      : undefined;
    if (!summary.previewAvailable || !profile)
      throw new MediaError(
        "UNSUPPORTED_PROFILE",
        "This source is preserved, but its preview color or precision path is not yet verified.",
      );
    const path = join(this.root, "assets", entry.source.file);
    if ((await hash(path, signal)) !== entry.source.sha256)
      throw new MediaError(
        "FIDELITY_MISMATCH",
        "The managed source has changed.",
      );
    const timingKey = `${id}:${entry.source.sha256}`;
    let timing = this.presentationTimings.get(timingKey);
    if (!timing) {
      timing = probePresentationTiming(
        this.ffprobe,
        path,
        video as Record<string, unknown>,
        signal,
      );
      this.presentationTimings.set(timingKey, timing);
      void timing.catch(() => this.presentationTimings.delete(timingKey));
    }
    const indexed = await timing;
    const seekUs = presentationSeekUs(indexed, timeUs);
    const measuredEndUs = Math.max(
      summary.durationUs,
      indexed.presentationEndUs ?? 0,
    );
    if (timeUs >= measuredEndUs)
      throw new MediaError("INVALID_INPUT", "Seek is outside the video.");
    const bytes = summary.width * summary.height * 4;
    const output = await runProcess({
      executable: this.ffmpeg,
      args: [
        "-v",
        "error",
        "-nostdin",
        "-protocol_whitelist",
        "file",
        "-format_whitelist",
        "matroska,webm,mov,avi",
        "-ss",
        (seekUs / 1_000_000).toFixed(6),
        "-noautorotate",
        "-i",
        path,
        "-map",
        "0:v:0",
        "-frames:v",
        "1",
        "-an",
        "-sn",
        "-dn",
        "-threads",
        "1",
        ...(profile === "h264-yuv420p"
          ? [
              "-vf",
              "scale=in_range=tv:out_range=pc:in_color_matrix=bt709:out_color_matrix=bt709:flags=accurate_rnd+full_chroma_int,format=bgra",
            ]
          : []),
        "-pix_fmt",
        "+bgra",
        "-f",
        "rawvideo",
        "pipe:1",
      ],
      maxOutputBytes: bytes + 64 * 1024,
      ...(signal ? { signal } : {}),
    });
    if (output.stdout.length !== bytes)
      throw new MediaError(
        "FIDELITY_MISMATCH",
        "Decoded frame dimensions did not match the source.",
      );
    const rgba = Buffer.from(output.stdout);
    for (let i = 0; i < rgba.length; i += 4) {
      const blue = rgba[i]!;
      rgba[i] = rgba[i + 2]!;
      rgba[i + 2] = blue;
    }
    const frame: MediaFrame = {
      width: summary.width,
      height: summary.height,
      rgbaBase64: rgba.toString("base64"),
    };
    assertMediaFrame(frame);
    return frame;
  }
}
