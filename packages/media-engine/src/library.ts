import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import type { Stats } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  writeFile,
} from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { isDeepStrictEqual } from "node:util";
import {
  assertFrameRequest,
  assertMediaFrame,
  assertMediaList,
  assertMediaSummary,
  assertThumbnail,
  maxFramePixels,
  mediaIdPattern,
  thumbnailWidth,
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
  // Large blocks: the 64 KiB default makes hashing a multi-gigabyte master
  // several times slower.
  for await (const chunk of handle.createReadStream({
    highWaterMark: 8 * 1024 * 1024,
  })) {
    assertNotCancelled(signal);
    digest.update(chunk as Buffer);
  }
  return digest.digest("hex");
}
const retryableRename = new Set(["EBUSY", "EPERM", "EACCES"]);
/** Moves a file; Windows briefly locks a file that was just written. */
async function moveWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 8 || !code || !retryableRename.has(code)) throw error;
      await new Promise((done) => setTimeout(done, 75 * (attempt + 1)));
    }
  }
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
    probe.color_primaries !== "bt709"
  )
    return undefined;
  // Full-range RGB is shown unchanged. Screen recordings are 8-bit RGB with
  // no alpha (bgr0) tagged sRGB; their samples are exactly what the display
  // produced, so the canvas shows them without conversion.
  if (
    (probe.pix_fmt === "bgra" || probe.pix_fmt === "bgr0") &&
    probe.color_range === "pc" &&
    probe.color_space === "gbr" &&
    (probe.color_transfer === "bt709" ||
      probe.color_transfer === "iec61966-2-1")
  )
    return "native-bgra";
  if (probe.color_transfer !== "bt709") return undefined;
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
  private readonly thumbnails = new Map<string, Promise<MediaFrame>>();
  private readonly stripFrames = new Map<string, Promise<MediaFrame>>();
  /**
   * Sources fully verified in this process, keyed by their file identity and
   * change times. Hashing a long recording on every draft read made each edit
   * cost seconds; any change to the file (content, size, times, replacement)
   * changes the key and forces a full re-verification.
   */
  private readonly verifiedFiles = new Map<
    string,
    { key: string; value: VerifiedLibrarySource }
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
  /** Identity of the managed file plus its stored record. */
  private sourceKey(stat: Stats, entry: Entry): string {
    return [
      stat.dev,
      stat.ino,
      stat.size,
      stat.mtimeMs,
      stat.ctimeMs,
      stat.nlink,
      // The stored record too: changed measurements must be re-checked.
      createHash("sha256").update(JSON.stringify(entry)).digest("hex"),
    ].join(":");
  }
  async verifiedSource(id: string): Promise<VerifiedLibrarySource> {
    await this.initialize();
    const entry = await this.entry(id);
    const managedPath = join(this.root, "assets", entry.source.file);
    const stat = await lstat(managedPath);
    const key = this.sourceKey(stat, entry);
    const known = this.verifiedFiles.get(id);
    if (
      known?.key === key &&
      stat.isFile() &&
      !stat.isSymbolicLink() &&
      stat.nlink === 1
    )
      return structuredClone(known.value);
    // One full read per file identity (the unchanged-identity check below
    // replaces a second hash).
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
    const after = await lstat(managedPath);
    if (
      !after.isFile() ||
      after.isSymbolicLink() ||
      after.nlink !== 1 ||
      after.size !== stat.size ||
      after.dev !== stat.dev ||
      after.ino !== stat.ino ||
      after.mtimeMs !== stat.mtimeMs ||
      after.ctimeMs !== stat.ctimeMs
    )
      throw new MediaError(
        "FIDELITY_MISMATCH",
        "The managed source changed during verification.",
      );
    const value: VerifiedLibrarySource = {
      summary: { ...entry.summary },
      originalPath: entry.source.originalPath,
      managedPath,
      sha256: entry.source.sha256,
      sizeBytes: entry.source.size,
      probe: structuredClone(entry.probe),
    };
    this.verifiedFiles.set(id, { key, value: structuredClone(value) });
    return value;
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
    options: { adopt?: { sha256: string } } = {},
  ): Promise<MediaSummary> {
    await this.initialize();
    assertNotCancelled(signal);
    if (!isAbsolute(sourcePath)) invalid();
    await regular(sourcePath);
    const size = (await lstat(sourcePath)).size;
    if (size <= 0 || size > 100 * 1024 ** 3) invalid();
    const id = randomUUID();
    const file = `${id}.media`;
    const target = join(this.root, "assets", file);
    let originalHash: string;
    /**
     * Adoption: the app's own just-finished recording (private folder, the
     * recorder already hashed it) is moved into the library instead of
     * copied and re-read. The index records that hash, and every later use
     * checks the file against it, so a wrong value can only fail closed.
     */
    let moved = false;
    if (options.adopt) {
      if (!/^[a-f0-9]{64}$/u.test(options.adopt.sha256)) invalid();
      try {
        await moveWithRetry(sourcePath, target);
        moved = true;
      } catch (error) {
        // Another volume cannot be renamed into; copy (and verify) instead.
        if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
      }
    }
    let published = false;
    try {
      let probe: unknown;
      if (moved) {
        originalHash = options.adopt!.sha256;
        probe = await this.probe(target, signal);
      } else {
        // The source is hashed while it is copied: one read, not two.
        const digest = createHash("sha256");
        const sourceHandle = await open(
          sourcePath,
          constants.O_RDONLY | (constants.O_NOFOLLOW || 0),
        );
        try {
          const destination = await open(target, "wx", 0o600);
          await pipeline(
            sourceHandle.createReadStream({ highWaterMark: 4 * 1024 * 1024 }),
            new Transform({
              transform(chunk: Buffer, _encoding, done) {
                digest.update(chunk);
                done(null, chunk);
              },
            }),
            destination.createWriteStream({ highWaterMark: 4 * 1024 * 1024 }),
            signal ? { signal } : {},
          );
        } finally {
          await sourceHandle.close();
        }
        assertNotCancelled(signal);
        originalHash = digest.digest("hex");
        // The copy, the source (unchanged while read) and the container
        // measurements are independent checks, so they run together.
        const [copied, again, measured] = await Promise.all([
          hash(target, signal),
          hash(sourcePath, signal),
          this.probe(target, signal),
        ]);
        if (copied !== originalHash || again !== originalHash)
          throw new MediaError(
            "FIDELITY_MISMATCH",
            "Source changed during import; no media was indexed.",
          );
        probe = measured;
      }
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
      const entry: Entry = {
        version: 1,
        summary,
        source: { file, originalPath: sourcePath, sha256: originalHash, size },
        probe,
      };
      const staged = join(this.root, "assets", `${id}.index-stage`);
      await writeFile(staged, JSON.stringify(entry), {
        flag: "wx",
        mode: 0o600,
      });
      await publishFileWithoutOverwrite(
        staged,
        join(this.root, "index", `${id}.json`),
        signal,
      );
      published = true;
      // Its bytes were just checked (or adopted), so the first preview and
      // project open need no further full read.
      try {
        const placed = await lstat(target);
        if (placed.size === size)
          this.verifiedFiles.set(id, {
            key: this.sourceKey(placed, entry),
            value: {
              summary: { ...summary },
              originalPath: sourcePath,
              managedPath: target,
              sha256: originalHash,
              sizeBytes: size,
              probe: structuredClone(entry.probe),
            },
          });
      } catch {
        /* The next use verifies the file in full. */
      }
      return summary;
    } catch (error) {
      // An adopted recording goes back where the recorder can still find it.
      if (moved && !published)
        await rename(target, sourcePath).catch(() => undefined);
      throw error;
    }
  }
  private async probe(path: string, signal?: AbortSignal): Promise<unknown> {
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
        path,
      ],
      ...(signal ? { signal } : {}),
    });
    return JSON.parse(result.stdout.toString("utf8")) as unknown;
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
    // Verified once per file identity; re-hashing a long recording for every
    // preview frame cost about as much as decoding the frame.
    const path = (await this.verifiedSource(id)).managedPath;
    signal?.throwIfAborted();
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
          : (video as Record<string, unknown>).pix_fmt === "bgr0"
            ? // Copies B, G and R unchanged and sets the unused byte to opaque.
              ["-vf", "scale,format=bgra"]
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
  /**
   * Small picture for library and project cards. It is cosmetic: FFmpeg's
   * default conversion and scaling are used, so it is never shown as a
   * review frame or used for rendering. Any decodable source qualifies.
   */
  async thumbnail(id: string, signal?: AbortSignal): Promise<MediaFrame> {
    await this.initialize();
    const entry = await this.entry(id);
    const key = `${id}:${entry.source.sha256}`;
    let pending = this.thumbnails.get(key);
    if (!pending) {
      pending = this.decodeThumbnail(entry, signal);
      if (this.thumbnails.size >= 128)
        this.thumbnails.delete(this.thumbnails.keys().next().value!);
      this.thumbnails.set(key, pending);
      void pending.catch(() => this.thumbnails.delete(key));
    }
    return pending;
  }
  /**
   * A small picture of a source at `timeUs` for the timeline filmstrip. Like
   * the card thumbnail it is cosmetic (FFmpeg's default conversion, never a
   * review frame). Times are rounded to half a second so a redrawn strip
   * after an edit reuses the pictures of everything that did not change.
   */
  async stripFrame(
    id: string,
    timeUs: number,
    signal?: AbortSignal,
  ): Promise<MediaFrame> {
    if (!Number.isSafeInteger(timeUs) || timeUs < 0)
      throw new MediaError("INVALID_INPUT", "Seek is outside the video.");
    await this.initialize();
    const entry = await this.entry(id);
    const { summary } = entry;
    const atUs = Math.min(
      // Seeking to the very end of a file yields no frame: stop short of it.
      Math.max(0, summary.durationUs - 500_000),
      Math.round(timeUs / 500_000) * 500_000,
    );
    const key = `${id}:${entry.source.sha256}:${atUs}`;
    let pending = this.stripFrames.get(key);
    if (!pending) {
      pending = this.decodeStripFrame(entry, atUs, signal);
      if (this.stripFrames.size >= 512)
        this.stripFrames.delete(this.stripFrames.keys().next().value!);
      this.stripFrames.set(key, pending);
      void pending.catch(() => this.stripFrames.delete(key));
    }
    return pending;
  }
  private async decodeStripFrame(
    entry: Entry,
    atUs: number,
    signal?: AbortSignal,
  ): Promise<MediaFrame> {
    const { summary } = entry;
    const width = Math.min(160, summary.width);
    const height = Math.max(
      2,
      Math.round((width * summary.height) / summary.width / 2) * 2,
    );
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
        (atUs / 1_000_000).toFixed(6),
        "-i",
        join(this.root, "assets", entry.source.file),
        "-map",
        "0:v:0",
        "-frames:v",
        "1",
        "-an",
        "-sn",
        "-dn",
        "-threads",
        "1",
        "-vf",
        `scale=${width}:${height}:flags=bilinear,format=rgba`,
        "-f",
        "rawvideo",
        "pipe:1",
      ],
      maxOutputBytes: width * height * 4 + 64 * 1024,
      ...(signal ? { signal } : {}),
    });
    if (output.stdout.length !== width * height * 4)
      throw new MediaError(
        "UNSUPPORTED_PROFILE",
        "No picture could be decoded for this source.",
      );
    const rgba = Buffer.from(output.stdout);
    for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
    const frame: MediaFrame = {
      width,
      height,
      rgbaBase64: rgba.toString("base64"),
    };
    assertThumbnail(frame);
    return frame;
  }
  private async decodeThumbnail(
    entry: Entry,
    signal?: AbortSignal,
  ): Promise<MediaFrame> {
    const { summary } = entry;
    const width = Math.min(thumbnailWidth, summary.width);
    const height = Math.max(
      2,
      Math.round((width * summary.height) / summary.width / 2) * 2,
    );
    // A frame a little way in avoids black lead-in frames.
    const atUs = Math.min(1_000_000, Math.floor(summary.durationUs / 10));
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
        (atUs / 1_000_000).toFixed(6),
        "-i",
        join(this.root, "assets", entry.source.file),
        "-map",
        "0:v:0",
        "-frames:v",
        "1",
        "-an",
        "-sn",
        "-dn",
        "-threads",
        "1",
        "-vf",
        `scale=${width}:${height}:flags=bicubic,format=rgba`,
        "-f",
        "rawvideo",
        "pipe:1",
      ],
      maxOutputBytes: width * height * 4 + 64 * 1024,
      ...(signal ? { signal } : {}),
    });
    if (output.stdout.length !== width * height * 4)
      throw new MediaError(
        "UNSUPPORTED_PROFILE",
        "No thumbnail could be decoded for this source.",
      );
    // Cards are opaque; any source alpha is not meaningful there.
    const rgba = Buffer.from(output.stdout);
    for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
    const frame: MediaFrame = {
      width,
      height,
      rgbaBase64: rgba.toString("base64"),
    };
    assertThumbnail(frame);
    return frame;
  }
}
