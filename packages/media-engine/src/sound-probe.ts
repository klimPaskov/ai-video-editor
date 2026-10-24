import { MediaError, runProcess } from "./process.ts";

/** Containers a sound file may be in; ffprobe refuses anything else. */
const soundFormats =
  "wav,w64,mp3,flac,ogg,aiff,aac,ac3,eac3,mov,matroska,webm,caf,amr,wv,ape,tta,asf,mpegts";

export interface SoundFileInfo {
  durationUs: number;
  sampleRate: number;
  channels: number;
}

/**
 * Reads the first audio stream of a file: its length, sample rate and
 * channels. Throws `MediaError` when the file has no audio this app can
 * read. Only local files and the listed containers are opened.
 */
export async function probeSoundFile(
  path: string,
  options: { ffprobe?: string; signal?: AbortSignal } = {},
): Promise<SoundFileInfo> {
  const result = await runProcess({
    executable: options.ffprobe ?? "ffprobe",
    args: [
      "-v",
      "error",
      "-protocol_whitelist",
      "file",
      "-format_whitelist",
      soundFormats,
      "-select_streams",
      "a:0",
      "-show_entries",
      "stream=sample_rate,channels,duration:format=duration",
      "-of",
      "json",
      path,
    ],
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const parsed: unknown = JSON.parse(result.stdout.toString("utf8"));
  const record = (value: unknown): Record<string, unknown> | null =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  const root = record(parsed);
  const streams = root?.streams;
  const stream = Array.isArray(streams) ? record(streams[0]) : null;
  const sampleRate = Number(stream?.sample_rate);
  const channels = Number(stream?.channels);
  // The stream's own length when it has one, else the container's.
  const seconds = Number(stream?.duration ?? record(root?.format)?.duration);
  if (
    !stream ||
    !Number.isSafeInteger(sampleRate) ||
    sampleRate < 8_000 ||
    sampleRate > 384_000 ||
    !Number.isSafeInteger(channels) ||
    channels < 1 ||
    channels > 8 ||
    !Number.isFinite(seconds) ||
    seconds <= 0
  )
    throw new MediaError("UNSUPPORTED_PROFILE", "No readable audio.");
  return {
    durationUs: Math.round(seconds * 1_000_000),
    sampleRate,
    channels,
  };
}
