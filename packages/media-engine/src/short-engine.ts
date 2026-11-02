import { runEngine } from "./engine-client.ts";
import type { ExportPlan } from "./render.ts";

/**
 * Short clips through the Rust engine (`clips.render`, docs/58): the app plans
 * which source frames and samples make up the clip, the engine renders it in
 * one pass with an optional face-following crop and checks the result.
 */

export interface ShortEngineInput {
  engine: string;
  plan: ExportPlan;
  outputPath: string;
  width: number;
  height: number;
  /** The app's own zoom filter (clip time), or empty. */
  zoomFilter: string;
  /** Motion graphics segments drawn over the frames. */
  graphics: readonly { path: string; startFrame: number }[];
  /** Fixed framing (fit with blurred fill, or a fill crop). */
  reframeFilter: string;
  /** Framing is "fill": the crop may follow a face. */
  fill: boolean;
  position: number;
  ass?: string;
  /** Verified YuNet model file, when available. */
  faceModel?: string | null;
  ffmpeg: string;
  ffprobe: string;
  encoder?: "software" | "hardware";
  signal?: AbortSignal;
  onProgress?: (fraction: number) => void;
}

export interface ShortEngineReport {
  output_path: string;
  bytes: number;
  frames: number;
  duration_us: number;
  encoder: string;
  framing: "follow" | "fixed";
  face_coverage: number;
  framing_note: string | null;
  attempts: number;
  analyse_ms: number;
  render_ms: number;
  verify_ms: number;
}

/** Why the engine path cannot make this clip (the caller uses the TypeScript path). */
export function engineLimit(options: { audioCleanup: boolean }): string | null {
  // Two-pass loudness measurement belongs to the verified export pipeline.
  return options.audioCleanup ? "audio cleanup" : null;
}

export function shortEngineParams(input: ShortEngineInput): unknown {
  const { plan } = input;
  const { video, audio } = plan.format;
  return {
    ffmpeg: input.ffmpeg,
    ffprobe: input.ffprobe,
    output_path: input.outputPath,
    width: input.width,
    height: input.height,
    source: {
      width: video.width,
      height: video.height,
      pixel_format: video.pixelFormat,
      frame_rate_num: video.frameRate.numerator,
      frame_rate_den: video.frameRate.denominator,
      has_audio: audio !== null,
      sample_rate: audio?.sampleRate ?? 0,
    },
    clips: plan.clips.map((clip) => ({
      path: clip.path,
      frame_count: clip.frameCount,
      trim_start_seconds: clip.trimStartSeconds,
      trim_end_seconds: clip.trimEndSeconds,
      seek_seconds: clip.seekSeconds,
      first_sample: clip.firstSample,
      sample_count: clip.sampleCount,
      speed: clip.speed,
      output_frames: clip.outputFrames,
      output_samples: clip.outputSamples,
    })),
    total_frames: plan.frameCount,
    total_samples: plan.sampleCount,
    zoom_filter: input.zoomFilter || null,
    graphics: input.graphics.map((segment) => ({
      path: segment.path,
      start_frame: segment.startFrame,
    })),
    reframe_filter: input.reframeFilter,
    fill: input.fill,
    fill_position: input.position,
    ass: input.ass ?? null,
    face_model: input.faceModel ?? null,
    encoder: input.encoder ?? "software",
  };
}

export async function renderShortWithEngine(
  input: ShortEngineInput,
): Promise<ShortEngineReport> {
  return runEngine<ShortEngineReport>({
    executable: input.engine,
    method: "clips.render",
    params: shortEngineParams(input),
    ...(input.signal ? { signal: input.signal } : {}),
    // Clips are short; a stuck job should not hold the Clips step for long.
    timeoutMs: Math.max(
      5 * 60_000,
      (planSeconds(input.plan) * 20 + 120) * 1000,
    ),
    onProgress: (_phase, fraction) => input.onProgress?.(fraction),
  });
}

function planSeconds(plan: ExportPlan): number {
  const rate = plan.format.video.frameRate;
  return (plan.frameCount * rate.denominator) / rate.numerator;
}
