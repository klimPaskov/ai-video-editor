import { spawn } from "node:child_process";
import { rename, rm } from "node:fs/promises";
import { runProcess } from "./process.ts";

/**
 * Display-only playback copies for sources Chromium cannot decode (for
 * example lossless FFV1/PCM screen recordings). A proxy keeps the source's
 * frame timing so preview positions map one to one, but it is lossy and is
 * never used for still frames, analysis or export.
 */

const playableVideo = new Set(["h264", "vp8", "vp9", "av1"]);
const playableAudio = new Set(["aac", "opus", "vorbis", "mp3", "flac"]);

type Stream = Record<string, unknown>;

function streams(probe: unknown): Stream[] {
  const list = (probe as { streams?: unknown })?.streams;
  return Array.isArray(list)
    ? list.filter(
        (item): item is Stream => item !== null && typeof item === "object",
      )
    : [];
}

/** True when Chromium needs a proxy to play this source. */
export function needsPlaybackProxy(probe: unknown): boolean {
  const all = streams(probe);
  const video = all.find((stream) => stream.codec_type === "video");
  if (!video || !playableVideo.has(String(video.codec_name))) return true;
  return all.some(
    (stream) =>
      stream.codec_type === "audio" &&
      !playableAudio.has(String(stream.codec_name)),
  );
}

export type ProxyEncoder = "h264" | "vp9";

/** Picks H.264/AAC in MP4 when available, else VP9/Opus in WebM. */
export async function proxyEncoder(ffmpeg: string): Promise<ProxyEncoder> {
  const { stdout } = await runProcess({
    executable: ffmpeg,
    args: ["-hide_banner", "-encoders"],
  });
  const text = stdout.toString();
  if (/\slibx264\s/u.test(text)) return "h264";
  if (/\slibvpx-vp9\s/u.test(text) && /\slibopus\s/u.test(text)) return "vp9";
  throw new Error("No playback encoder is available.");
}

export function proxyMime(encoder: ProxyEncoder): string {
  return encoder === "h264" ? "video/mp4" : "video/webm";
}

export function proxyArguments(options: {
  input: string;
  output: string;
  encoder: ProxyEncoder;
  hasAudio: boolean;
}): string[] {
  const video =
    options.encoder === "h264"
      ? [
          "-c:v",
          "libx264",
          "-preset",
          "veryfast",
          "-crf",
          "18",
          // No reordered frames: presentation equals decode order, so every
          // frame keeps the source timestamp with no edit-list offset.
          "-bf",
          "0",
          "-tune",
          "fastdecode",
          // A key frame every second keeps seeking quick.
          "-g",
          "30",
          "-keyint_min",
          "1",
        ]
      : [
          "-c:v",
          "libvpx-vp9",
          "-deadline",
          "realtime",
          "-cpu-used",
          "8",
          "-crf",
          "30",
          "-b:v",
          "0",
          "-g",
          "30",
        ];
  const audio = options.hasAudio
    ? options.encoder === "h264"
      ? ["-map", "0:a:0", "-c:a", "aac", "-b:a", "192k"]
      : ["-map", "0:a:0", "-c:a", "libopus", "-b:a", "160k"]
    : [];
  return [
    "-hide_banner",
    "-nostdin",
    "-loglevel",
    "error",
    "-progress",
    "pipe:1",
    "-i",
    options.input,
    "-map",
    "0:v:0",
    ...audio,
    // Same frames at the same times: no frame-rate conversion.
    "-fps_mode",
    "passthrough",
    "-vf",
    "scale=out_color_matrix=bt709:out_range=tv:flags=bicubic+accurate_rnd,format=yuv420p",
    "-color_range",
    "tv",
    "-colorspace",
    "bt709",
    "-color_primaries",
    "bt709",
    "-color_trc",
    "bt709",
    ...video,
    ...(options.encoder === "h264" ? ["-movflags", "+faststart"] : []),
    "-f",
    options.encoder === "h264" ? "mp4" : "webm",
    options.output,
  ];
}

/**
 * Writes the proxy beside `output` and renames it into place when complete,
 * so a partial file is never served.
 */
export async function createPlaybackProxy(options: {
  ffmpeg: string;
  input: string;
  output: string;
  encoder: ProxyEncoder;
  hasAudio: boolean;
  durationUs: number;
  signal?: AbortSignal;
  onProgress?: (fraction: number) => void;
}): Promise<void> {
  const partial = `${options.output}.partial`;
  const args = proxyArguments({ ...options, output: partial });
  await new Promise<void>((resolve, reject) => {
    const child = spawn(options.ffmpeg, args, {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const abort = () => child.kill("SIGKILL");
    options.signal?.addEventListener("abort", abort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      const match = /out_time_us=(\d+)/u.exec(chunk);
      if (match && options.durationUs > 0)
        options.onProgress?.(
          Math.min(1, Number(match[1]) / options.durationUs),
        );
    });
    child.stderr.resume();
    child.once("error", reject);
    child.once("close", (code) => {
      options.signal?.removeEventListener("abort", abort);
      if (options.signal?.aborted) reject(new Error("Cancelled"));
      else if (code === 0) resolve();
      else reject(new Error("The playback copy could not be made."));
    });
  }).catch(async (error: unknown) => {
    await rm(partial, { force: true }).catch(() => undefined);
    throw error;
  });
  await rename(partial, options.output);
  options.onProgress?.(1);
}
