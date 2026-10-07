import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { createReadStream } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { endianness } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import type {
  LocalTranscript,
  TranscriptAnalysis,
  TranscriptSegment,
  TranscriptSilence,
  TranscriptWord,
  TranscriptWordFlag,
} from "../../domain/src/transcription.ts";
import {
  assertLocalTranscript,
  assertTranscriptAnalysis,
} from "../../domain/src/transcription.ts";
import { MediaError, runProcess } from "./process.ts";

export const speechAudioProfile = Object.freeze({
  version: "1",
  sampleRate: 16_000,
  channels: 1,
  format: "f32le",
  noiseDb: -40,
  minimumSilenceUs: 250_000,
});

export const localSpeechChunkLengthSeconds = 30;
export const localSpeechChunkStrideSeconds = 5;

export const localSpeechModel = Object.freeze({
  id: "Xenova/whisper-base",
  revision: "64da57285918e20ea79ea5c88eed7197933abaa8",
  dtype: "q8",
  device: "cpu",
  license: "Apache-2.0",
  estimatedBytes: 79_677_901,
  files: [
    {
      name: "onnx/encoder_model_quantized.onnx",
      size: 23_200_850,
      sha256:
        "3e345e977b55620a37c0c2b2af0644e019afdfad562dcf71eb929bb7274285f9",
    },
    {
      name: "onnx/decoder_model_merged_quantized.onnx",
      size: 53_707_539,
      sha256:
        "a6beb6baabb66f00b6a686d828c95ffca6146d51900cbad0266cad38f64cf861",
    },
  ],
});

export interface TimedWordChunk {
  text: string;
  timestamp: readonly [number, number];
  flags?: TranscriptWordFlag[];
}

export type TranscriptBuildFailureReason =
  | "invalid_options"
  | "invalid_chunk"
  | "invalid_timing"
  | "out_of_order"
  | "outside_source"
  | "invalid_transcript";

export class TranscriptBuildError extends Error {
  readonly reason: TranscriptBuildFailureReason;

  constructor(reason: TranscriptBuildFailureReason) {
    super("Local transcript timing could not be validated.");
    this.reason = reason;
  }
}

/** Keep only empty model chunks without timing; spoken words require exact estimated bounds. */
export function normalizeTimedWordChunks(
  value: unknown,
  maximumBacktrackUs = localSpeechChunkStrideSeconds * 1_000_000,
): TimedWordChunk[] {
  if (!Array.isArray(value)) fail();
  if (!Number.isSafeInteger(maximumBacktrackUs) || maximumBacktrackUs < 0)
    fail();
  const chunks: Array<{ word: TimedWordChunk; originalIndex: number }> = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail();
    const word = raw as Record<string, unknown>;
    if (typeof word.text !== "string") fail();
    if (!word.text.trim()) continue;
    if (
      !Array.isArray(word.timestamp) ||
      word.timestamp.length !== 2 ||
      !word.timestamp.every(
        (part) => typeof part === "number" && Number.isFinite(part),
      )
    )
      fail();
    chunks.push({
      word: {
        text: word.text,
        timestamp: [word.timestamp[0] as number, word.timestamp[1] as number],
      },
      originalIndex: chunks.length,
    });
  }
  let highestStartSeconds = Number.NEGATIVE_INFINITY;
  for (const entry of chunks) {
    const startSeconds = entry.word.timestamp[0];
    if (
      Math.round((highestStartSeconds - startSeconds) * 1_000_000) >
      maximumBacktrackUs
    )
      throw new TranscriptBuildError("out_of_order");
    highestStartSeconds = Math.max(highestStartSeconds, startSeconds);
  }
  const ordered = [...chunks].sort(
    (left, right) =>
      left.word.timestamp[0] - right.word.timestamp[0] ||
      left.originalIndex - right.originalIndex,
  );
  return ordered.map((entry, index) => ({
    ...entry.word,
    ...(entry.originalIndex !== index ? { flags: ["uncertain" as const] } : {}),
  }));
}

export interface TranscriptBuildOptions {
  projectId: string;
  sourceId: string;
  durationUs: number;
  sourceStartUs: number;
  language?: string | null;
  modelSha256?: string;
  transcriptId?: string;
  warnings?: string[];
}

function fail(): never {
  throw new MediaError(
    "INVALID_INPUT",
    "Local transcription output is invalid.",
  );
}

function cleanWordText(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function punctuationOnly(value: string): boolean {
  return /^[,.;:!?…%)}\]»”’]+$/u.test(value);
}

function joinWords(words: readonly TranscriptWord[]): string {
  let result = "";
  for (const word of words) {
    const token = word.text.trim();
    if (!token) continue;
    if (
      punctuationOnly(token) ||
      /^[([{«“‘]/u.test(token) ||
      token.startsWith("'")
    )
      result = result.trimEnd() + token;
    else result = result ? `${result} ${token}` : token;
  }
  return result.trim();
}

function segmentWords(words: TranscriptWord[]): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];
  let group: TranscriptWord[] = [];
  const flush = () => {
    if (group.length === 0) return;
    const first = group[0]!;
    const last = group[group.length - 1]!;
    const text = joinWords(group);
    if (text) {
      segments.push({
        segment_id: `segment-${String(segments.length + 1).padStart(6, "0")}`,
        start_us: first.start_us,
        end_us: group.reduce(
          (latest, word) => Math.max(latest, word.end_us),
          last.end_us,
        ),
        text,
        words: group,
      });
    }
    group = [];
  };

  for (const word of words) {
    const prior = group[group.length - 1];
    if (
      prior &&
      (group.length >= 80 ||
        word.start_us - prior.end_us > 1_000_000 ||
        /[.!?…]$/u.test(prior.text.trim()))
    )
      flush();
    group.push(word);
  }
  flush();
  return segments;
}

const endOfAudioWarning =
  "A word the local model placed at the very end of the audio was left out.";

export function buildLocalTranscript(
  options: TranscriptBuildOptions,
  chunks: readonly TimedWordChunk[],
): LocalTranscript {
  if (
    !Number.isSafeInteger(options.durationUs) ||
    options.durationUs < 0 ||
    !Number.isSafeInteger(options.sourceStartUs)
  )
    throw new TranscriptBuildError("invalid_options");
  const warnings = [...(options.warnings ?? [])];
  if (chunks.some((chunk) => chunk.flags?.includes("uncertain")))
    warnings.push(
      "Word order was reconciled within overlapping local model chunks; review uncertain timings before editing.",
    );
  const words: TranscriptWord[] = [];
  let priorStartUs = -1;
  for (const chunk of chunks) {
    if (
      !chunk ||
      typeof chunk.text !== "string" ||
      !Array.isArray(chunk.timestamp) ||
      chunk.timestamp.length !== 2 ||
      !chunk.timestamp.every(Number.isFinite)
    )
      throw new TranscriptBuildError("invalid_chunk");
    const text = cleanWordText(chunk.text);
    if (!text) continue;
    const [startSeconds, endSeconds] = chunk.timestamp;
    if (startSeconds < 0 || endSeconds < startSeconds)
      throw new TranscriptBuildError("invalid_timing");
    const startUs =
      Math.round(startSeconds * 1_000_000) + options.sourceStartUs;
    const estimatedEndUs =
      Math.round(endSeconds * 1_000_000) + options.sourceStartUs;
    if (
      !Number.isSafeInteger(startUs) ||
      !Number.isSafeInteger(estimatedEndUs) ||
      startUs < 0
    )
      throw new TranscriptBuildError("invalid_timing");
    if (startUs >= options.durationUs) {
      // The model can place a final word at or just past the end of the
      // audio (its window edge). Such a word is left out with a warning; a
      // word well beyond the end means the audio does not match the source.
      if (startUs - options.durationUs > 250_000)
        throw new TranscriptBuildError("outside_source");
      if (!warnings.includes(endOfAudioWarning))
        warnings.push(endOfAudioWarning);
      continue;
    }
    if (startUs < priorStartUs) throw new TranscriptBuildError("out_of_order");
    const endUs = Math.min(estimatedEndUs, options.durationUs);
    if (endUs < startUs) throw new TranscriptBuildError("invalid_timing");
    priorStartUs = startUs;
    words.push({
      word_id: `word-${String(words.length + 1).padStart(8, "0")}`,
      text,
      start_us: startUs,
      end_us: endUs,
      confidence: null,
      flags: chunk.flags ?? [],
    });
  }
  if (words.length === 0) warnings.push("No speech words were recognized.");
  warnings.push(
    "Word timings are local model estimates; verify before editing.",
  );
  const transcript: LocalTranscript = {
    schema_version: "1.0",
    transcript_id: options.transcriptId ?? `transcript-${randomUUID()}`,
    project_id: options.projectId,
    source_id: options.sourceId,
    duration_us: options.durationUs,
    language: options.language?.trim() || "und",
    model: {
      provider: "local",
      name: `${localSpeechModel.id}-${localSpeechModel.dtype}`,
      version: localSpeechModel.revision,
      sha256: options.modelSha256 ?? null,
      device: localSpeechModel.device,
    },
    segments: segmentWords(words),
    warnings: [...new Set(warnings)],
  };
  try {
    assertLocalTranscript(transcript);
  } catch {
    throw new TranscriptBuildError("invalid_transcript");
  }
  return transcript;
}

function secondsToUs(value: string): number | undefined {
  if (!/^-?\d+(?:\.\d+)?$/u.test(value)) return undefined;
  const result = Number(value) * 1_000_000;
  return Number.isSafeInteger(Math.round(result))
    ? Math.round(result)
    : undefined;
}

export function parseSilenceDetection(
  stderr: string,
  sourceStartUs: number,
  sourceDurationUs: number,
): TranscriptSilence[] {
  if (
    !Number.isSafeInteger(sourceStartUs) ||
    !Number.isSafeInteger(sourceDurationUs) ||
    sourceDurationUs < 0
  )
    fail();
  const ranges: TranscriptSilence[] = [];
  let startUs: number | undefined;
  const events = /silence_(start|end):\s*(-?\d+(?:\.\d+)?)/gu;
  for (const event of stderr.matchAll(events)) {
    const eventUs = secondsToUs(event[2]!);
    if (eventUs === undefined) continue;
    if (event[1] === "start") {
      startUs = eventUs;
      continue;
    }
    if (startUs === undefined) continue;
    const start = Math.max(0, sourceStartUs + startUs);
    const end = Math.min(sourceDurationUs, sourceStartUs + eventUs);
    if (end - start >= speechAudioProfile.minimumSilenceUs)
      ranges.push({ start_us: start, end_us: end });
    startUs = undefined;
  }
  if (startUs !== undefined) {
    const start = Math.max(0, sourceStartUs + startUs);
    if (sourceDurationUs - start >= speechAudioProfile.minimumSilenceUs)
      ranges.push({ start_us: start, end_us: sourceDurationUs });
  }
  const merged: TranscriptSilence[] = [];
  for (const range of ranges.sort((a, b) => a.start_us - b.start_us)) {
    const prior = merged[merged.length - 1];
    if (prior && range.start_us <= prior.end_us)
      prior.end_us = Math.max(prior.end_us, range.end_us);
    else merged.push({ ...range });
  }
  return merged.filter((range) => range.end_us > range.start_us);
}

export interface SpeechAudioProxyRequest {
  ffmpegExecutable: string;
  sourcePath: string;
  outputPath: string;
  audioStreamIndex: number;
  sourceStartUs: number;
  sourceDurationUs: number;
  signal?: AbortSignal;
}

export interface SpeechAudioProxyResult {
  path: string;
  sampleRate: 16_000;
  channels: 1;
  format: "f32le";
  sampleCount: number;
  durationUs: number;
  sourceStartUs: number;
  silences: TranscriptSilence[];
}

/** Analysis-only decode; never use this resampled derivative as master input. */
export async function extractSpeechAudioProxy(
  request: SpeechAudioProxyRequest,
): Promise<SpeechAudioProxyResult> {
  if (
    !request.ffmpegExecutable ||
    !isAbsolute(request.sourcePath) ||
    !isAbsolute(request.outputPath) ||
    !Number.isSafeInteger(request.audioStreamIndex) ||
    request.audioStreamIndex < 0 ||
    !Number.isSafeInteger(request.sourceStartUs) ||
    request.sourceStartUs < 0 ||
    !Number.isSafeInteger(request.sourceDurationUs) ||
    request.sourceDurationUs <= request.sourceStartUs
  )
    fail();
  const outputPath = resolve(request.outputPath);
  await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
  const sourceStat = await lstat(request.sourcePath).catch(() => fail());
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) fail();
  await lstat(outputPath).then(
    () => fail(),
    (error: unknown) => {
      if (
        !error ||
        typeof error !== "object" ||
        !("code" in error) ||
        error.code !== "ENOENT"
      )
        fail();
    },
  );
  const { stderr } = await runProcess({
    executable: request.ffmpegExecutable,
    args: [
      "-hide_banner",
      "-nostdin",
      "-loglevel",
      "info",
      "-i",
      request.sourcePath,
      "-t",
      ((request.sourceDurationUs - request.sourceStartUs) / 1_000_000).toFixed(
        6,
      ),
      "-map",
      `0:${request.audioStreamIndex}`,
      "-vn",
      "-sn",
      "-dn",
      "-af",
      `silencedetect=noise=${speechAudioProfile.noiseDb}dB:d=${speechAudioProfile.minimumSilenceUs / 1_000_000},aresample=${speechAudioProfile.sampleRate}:async=0`,
      "-ac",
      String(speechAudioProfile.channels),
      "-ar",
      String(speechAudioProfile.sampleRate),
      "-c:a",
      "pcm_f32le",
      "-f",
      speechAudioProfile.format,
      outputPath,
    ],
    timeoutMs: 1_800_000,
    ...(request.signal ? { signal: request.signal } : {}),
    maxOutputBytes: 16 * 1024 * 1024,
  });
  const fileStat = await lstat(outputPath);
  if (
    !fileStat.isFile() ||
    fileStat.isSymbolicLink() ||
    fileStat.nlink !== 1 ||
    fileStat.size < 4 ||
    fileStat.size % 4 !== 0 ||
    fileStat.size > 1_000_000_000
  )
    throw new MediaError(
      "UNSUPPORTED_PROFILE",
      "The source audio could not be prepared for local transcription.",
    );
  const sampleCount = fileStat.size / 4;
  const durationUs = Math.round(
    (sampleCount * 1_000_000) / speechAudioProfile.sampleRate,
  );
  const result: SpeechAudioProxyResult = {
    path: outputPath,
    sampleRate: speechAudioProfile.sampleRate,
    channels: speechAudioProfile.channels,
    format: speechAudioProfile.format,
    sampleCount,
    durationUs,
    sourceStartUs: request.sourceStartUs,
    silences: parseSilenceDetection(
      stderr.toString("utf8"),
      request.sourceStartUs,
      request.sourceDurationUs,
    ),
  };
  return result;
}

export function buildTranscriptAnalysis(options: {
  projectId: string;
  sourceId: string;
  sourceSha256: string;
  durationUs: number;
  silences: readonly TranscriptSilence[];
}): TranscriptAnalysis {
  const analysis: TranscriptAnalysis = {
    schema_version: "1.0",
    project_id: options.projectId,
    source_id: options.sourceId,
    source_sha256: options.sourceSha256,
    duration_us: options.durationUs,
    silence_policy: {
      version: "1",
      noise_db: speechAudioProfile.noiseDb,
      minimum_duration_us: speechAudioProfile.minimumSilenceUs,
    },
    silences: options.silences.map((silence) => ({ ...silence })),
  };
  assertTranscriptAnalysis(analysis);
  return analysis;
}

export async function readSpeechAudioProxy(
  path: string,
): Promise<Float32Array> {
  if (!isAbsolute(path) || endianness() !== "LE") fail();
  const filePath = resolve(path);
  const before = await lstat(filePath).catch(() => fail());
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1 ||
    before.size < 4 ||
    before.size % 4 !== 0 ||
    before.size > 1_000_000_000
  )
    fail();
  const handle = await open(
    filePath,
    constants.O_RDONLY | (constants.O_NOFOLLOW || 0),
  );
  try {
    const actual = await handle.stat();
    if (
      !actual.isFile() ||
      actual.nlink !== 1 ||
      actual.size !== before.size ||
      actual.dev !== before.dev ||
      actual.ino !== before.ino
    )
      fail();
    const bytes = await handle.readFile();
    if (bytes.length !== actual.size) fail();
    const aligned = Buffer.allocUnsafeSlow(bytes.length);
    bytes.copy(aligned);
    return new Float32Array(
      aligned.buffer,
      aligned.byteOffset,
      aligned.byteLength / 4,
    );
  } finally {
    await handle.close();
  }
}

export interface ModelDownloadProgress {
  completedBytes: number;
  totalBytes: number;
}

export async function downloadSpeechModelWeights(
  cacheRoot: string,
  signal?: AbortSignal,
  onProgress?: (progress: ModelDownloadProgress) => void,
): Promise<string> {
  if (!isAbsolute(cacheRoot)) fail();
  const root = resolve(
    cacheRoot,
    localSpeechModel.id,
    localSpeechModel.revision,
  );
  await mkdir(root, { recursive: true, mode: 0o700 });
  const partial: string[] = [];
  let completedBytes = 0;
  const totalBytes = localSpeechModel.files.reduce(
    (sum, file) => sum + file.size,
    0,
  );
  try {
    for (const file of localSpeechModel.files) {
      if (signal?.aborted)
        throw new MediaError("CANCELLED", "Local transcription cancelled.");
      const path = resolve(root, file.name);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const existing = await lstat(path).catch((error: unknown) => {
        if (
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "ENOENT"
        )
          return undefined;
        throw error;
      });
      if (existing) {
        if (
          !existing.isFile() ||
          existing.isSymbolicLink() ||
          existing.nlink !== 1 ||
          existing.size !== file.size
        )
          throw new MediaError(
            "FIDELITY_MISMATCH",
            "The local speech model failed its integrity check.",
          );
        const digest = createHash("sha256");
        for await (const chunk of createReadStream(path)) digest.update(chunk);
        if (digest.digest("hex") !== file.sha256)
          throw new MediaError(
            "FIDELITY_MISMATCH",
            "The local speech model failed its integrity check.",
          );
        completedBytes += file.size;
        onProgress?.({ completedBytes, totalBytes });
        continue;
      }
      const url = `https://huggingface.co/${localSpeechModel.id}/resolve/${localSpeechModel.revision}/${file.name}`;
      const response = await fetch(url, {
        ...(signal ? { signal } : {}),
        redirect: "follow",
      }).catch(() => {
        throw new MediaError(
          signal?.aborted ? "CANCELLED" : "PROCESS_FAILED",
          signal?.aborted
            ? "Local transcription cancelled."
            : "The local speech model could not be downloaded. Try again.",
        );
      });
      const finalUrl = new URL(response.url);
      if (
        !response.ok ||
        finalUrl.protocol !== "https:" ||
        (finalUrl.hostname !== "huggingface.co" &&
          !finalUrl.hostname.endsWith(".hf.co")) ||
        !response.body
      )
        throw new MediaError(
          "PROCESS_FAILED",
          "The local speech model could not be downloaded. Try again.",
        );
      const temp = `${path}.${randomUUID()}.tmp`;
      partial.push(temp);
      const handle = await open(temp, "wx", 0o600);
      const digest = createHash("sha256");
      let fileBytes = 0;
      try {
        for await (const chunkValue of response.body) {
          if (signal?.aborted)
            throw new MediaError("CANCELLED", "Local transcription cancelled.");
          const chunk = Buffer.from(chunkValue);
          fileBytes += chunk.length;
          if (fileBytes > file.size)
            throw new MediaError(
              "FIDELITY_MISMATCH",
              "The local speech model failed its integrity check.",
            );
          digest.update(chunk);
          let offset = 0;
          while (offset < chunk.length) {
            const { bytesWritten } = await handle.write(
              chunk,
              offset,
              chunk.length - offset,
            );
            if (bytesWritten <= 0) fail();
            offset += bytesWritten;
          }
          onProgress?.({
            completedBytes: completedBytes + fileBytes,
            totalBytes,
          });
        }
        if (fileBytes !== file.size || digest.digest("hex") !== file.sha256)
          throw new MediaError(
            "FIDELITY_MISMATCH",
            "The local speech model failed its integrity check.",
          );
        await handle.sync();
      } finally {
        await handle.close();
      }
      await import("node:fs/promises").then(({ rename }) => rename(temp, path));
      partial.pop();
      completedBytes += fileBytes;
      onProgress?.({ completedBytes, totalBytes });
    }
    return await verifySpeechModelCache(cacheRoot);
  } finally {
    const { unlink } = await import("node:fs/promises");
    await Promise.all(
      partial.map((path) => unlink(path).catch(() => undefined)),
    );
  }
}

export async function verifySpeechModelCache(
  cacheRoot: string,
): Promise<string> {
  if (!isAbsolute(cacheRoot)) fail();
  const aggregate = createHash("sha256");
  for (const file of localSpeechModel.files) {
    const path = resolve(
      cacheRoot,
      localSpeechModel.id,
      localSpeechModel.revision,
      file.name,
    );
    const fileStat = await lstat(path).catch(() => fail());
    if (
      !fileStat.isFile() ||
      fileStat.isSymbolicLink() ||
      fileStat.nlink !== 1 ||
      fileStat.size !== file.size
    )
      fail();
    const digest = createHash("sha256");
    for await (const chunk of createReadStream(path)) digest.update(chunk);
    const actualHash = digest.digest("hex");
    if (actualHash !== file.sha256)
      throw new MediaError(
        "FIDELITY_MISMATCH",
        "The local speech model failed its integrity check.",
      );
    aggregate.update(file.name);
    aggregate.update("\0");
    aggregate.update(actualHash);
  }
  return aggregate.digest("hex");
}
