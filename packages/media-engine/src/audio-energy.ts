import type { EnergyTrack } from "../../domain/src/audio-energy.ts";
import { MediaError, runProcess } from "./process.ts";

/** One frame of the track, in microseconds (10 ms). */
export const energyFrameUs = 10_000;
/** The audio is read at this rate; speech needs no more. */
const sampleRate = 16_000;
const samplesPerFrame = (sampleRate * energyFrameUs) / 1_000_000;

/**
 * Parses FFmpeg's `ametadata=print` text for `astats` frames into linear RMS
 * values. Each frame prints a `pts_time` line and an RMS level in dB; silence
 * prints `-inf`.
 */
export function parseEnergyLevels(text: string): number[] {
  const levels: number[] = [];
  for (const line of text.split(/\r?\n/u)) {
    const match = /lavfi\.astats\.Overall\.RMS_level=(.+)$/u.exec(line.trim());
    if (!match) continue;
    const value = match[1]!.trim();
    const db = value === "-inf" ? -Infinity : Number(value);
    levels.push(Number.isFinite(db) ? 10 ** (db / 20) : 0);
  }
  return levels;
}

/**
 * Loudness of a file's first audio stream over time, 10 ms at a time. The
 * file is only read. Throws `MediaError` when there is no audio to measure.
 */
export async function decodeEnergyTrack(options: {
  ffmpeg: string;
  path: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<EnergyTrack> {
  const { stdout } = await runProcess({
    executable: options.ffmpeg,
    args: [
      "-v",
      "error",
      "-nostdin",
      "-i",
      options.path,
      "-map",
      "0:a:0",
      "-af",
      // Mono at 16 kHz first, so 160 samples are 10 ms; one statistic per
      // frame, printed to stdout.
      `aresample=${sampleRate},aformat=channel_layouts=mono,asetnsamples=n=${samplesPerFrame}:p=0,astats=metadata=1:reset=1,ametadata=mode=print:key=lavfi.astats.Overall.RMS_level:file=-`,
      "-f",
      "null",
      "-",
    ],
    // A long recording prints about one short line per frame.
    maxOutputBytes: 256 * 1024 * 1024,
    timeoutMs: options.timeoutMs ?? 30 * 60_000,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const rms = Float32Array.from(parseEnergyLevels(stdout.toString("utf8")));
  if (rms.length === 0)
    throw new MediaError(
      "INVALID_INPUT",
      "No audio could be measured in this recording.",
    );
  return { frameUs: energyFrameUs, rms };
}
