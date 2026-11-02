import {
  findActivityTargets,
  type ActivityTarget,
} from "../../domain/src/screen-activity.ts";
import { MediaError, runProcess } from "./process.ts";

const width = 192;
const height = 108;
const framesPerSecond = 5;
const frameUs = 1_000_000 / framesPerSecond;

/**
 * Where things happen on a screen recording: it is read at a few small
 * grayscale pictures a second (never changed or kept) and compared. Throws
 * `MediaError` when the recording has no picture.
 */
export async function analyzeScreenActivity(options: {
  ffmpeg: string;
  path: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<ActivityTarget[]> {
  const { stdout } = await runProcess({
    executable: options.ffmpeg,
    args: [
      "-v",
      "error",
      "-nostdin",
      "-i",
      options.path,
      "-map",
      "0:v:0",
      "-an",
      "-vf",
      `fps=${framesPerSecond},scale=${width}:${height}:flags=area,format=gray`,
      "-f",
      "rawvideo",
      "-",
    ],
    maxOutputBytes: 768 * 1024 * 1024,
    timeoutMs: options.timeoutMs ?? 30 * 60_000,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const frameBytes = width * height;
  const count = Math.floor(stdout.length / frameBytes);
  if (count < 2)
    throw new MediaError(
      "INVALID_INPUT",
      "No picture could be read from this recording.",
    );
  const frames: Uint8Array[] = [];
  for (let index = 0; index < count; index++)
    frames.push(stdout.subarray(index * frameBytes, (index + 1) * frameBytes));
  return findActivityTargets(frames, width, height, frameUs);
}
