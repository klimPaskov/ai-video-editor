import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  toAss,
  type CaptionCue,
  type CaptionSettings,
} from "../../../packages/domain/src/captions.ts";
import { zoomFilter } from "../../../packages/domain/src/zoom.ts";
import { exportDraft } from "../../../packages/media-engine/src/render.ts";
import { runProcess } from "../../../packages/media-engine/src/process.ts";
import { planDraft, type DraftReader } from "./export.ts";
import type { GraphicsRenderRequest, GraphicsTrack } from "./graphics-track.ts";

/** One rendered picture of the edit, as JPEG for an assistant to look at. */
export interface DraftFrame {
  timeUs: number;
  width: number;
  height: number;
  mimeType: "image/jpeg";
  dataBase64: string;
}

export const frameLimits = Object.freeze({
  maxFrames: 3,
  minWidth: 320,
  maxWidth: 1280,
  defaultWidth: 960,
  /** Base64 budget for all frames of one call, under the 1 MiB broker frame. */
  maxTotalBase64: 700 * 1024,
});

export interface FrameRenderOptions {
  drafts: DraftReader;
  projectId: string;
  timesUs: readonly number[];
  maxWidth: number;
  /** Captions as the preview shows them (when on), in draft output time. */
  captions: () => Promise<{
    cues: CaptionCue[];
    settings: CaptionSettings;
  } | null>;
  renderGraphics?: (
    request: GraphicsRenderRequest,
  ) => Promise<GraphicsTrack | null>;
  ffmpeg?: string;
  ffprobe?: string;
  signal?: AbortSignal;
}

export class FrameRenderError extends Error {}

/** Scales so the longer side fits `maxSide` (portrait video stays small too). */
function jpegSize(width: number, height: number, maxSide: number) {
  const scale = Math.min(1, maxSide / Math.max(width, height));
  // Even dimensions keep the JPEG encoder's chroma layout simple.
  const outWidth = Math.max(2, Math.round((width * scale) / 2) * 2);
  const outHeight = Math.max(2, Math.round((height * scale) / 2) * 2);
  return { outWidth, outHeight };
}

/**
 * Renders each requested output time through the export compositor (zooms,
 * motion graphics, then captions as the preview shows them) into a one-frame
 * lossless master in a private scratch folder, then decodes that frame to a
 * small JPEG. The JPEG is analysis output only; it never feeds a master.
 */
export async function renderDraftFrames(
  options: FrameRenderOptions,
): Promise<DraftFrame[]> {
  const ffmpeg = options.ffmpeg ?? "ffmpeg";
  const ffprobe = options.ffprobe ?? "ffprobe";
  const captions = await options.captions().catch(() => null);
  const frames: DraftFrame[] = [];
  let budget = frameLimits.maxTotalBase64;
  const scratch = await mkdtemp(path.join(tmpdir(), "ai-video-editor-frames-"));
  try {
    for (const [index, requested] of options.timesUs.entries()) {
      if (options.signal?.aborted) throw new FrameRenderError("cancelled");
      const snapshot = await options.drafts.snapshotWithProject(
        options.projectId,
      );
      const { numerator, denominator } = snapshot.draft.timeline.frame_rate;
      const frameUs = Math.ceil((denominator * 1_000_000) / numerator);
      const durationUs = snapshot.draft.timeline.duration_us;
      if (
        !Number.isSafeInteger(requested) ||
        requested < 0 ||
        requested >= durationUs
      )
        throw new FrameRenderError("time");
      const startUs = Math.max(0, Math.min(requested, durationUs - frameUs));
      const endUs = Math.min(durationUs, startUs + frameUs);
      const planned = await planDraft(
        options.drafts,
        ffprobe,
        options.projectId,
        { startUs, endUs },
      );
      const { zooms, graphics } = planned;
      // Pictures need no sound: a video-only plan avoids decoding each
      // source's audio from its start for every frame.
      const plan = {
        ...planned.plan,
        format: { ...planned.plan.format, audio: null },
        sampleCount: 0,
      };
      const video = plan.format.video;
      const directory = path.join(scratch, `frame-${index}`);
      await mkdir(directory, { recursive: true });
      let track: GraphicsTrack | null = null;
      if (graphics.length) {
        if (!options.renderGraphics) throw new FrameRenderError("graphics");
        track = await options.renderGraphics({
          intervals: graphics,
          width: video.width,
          height: video.height,
          frameRate: video.frameRate,
          frameCount: plan.frameCount,
          directory,
          ffmpeg,
          ...(options.signal ? { signal: options.signal } : {}),
        });
      }
      const cues = captions?.settings.enabled
        ? captions.cues
            .filter((cue) => cue.endUs > startUs && cue.startUs < endUs)
            .map((cue) => ({
              ...cue,
              startUs: Math.max(0, cue.startUs - startUs),
              endUs: cue.endUs - startUs,
            }))
        : [];
      const ass = cues.length
        ? toAss(cues, captions!.settings, video.width, video.height)
        : undefined;
      const filter = zoomFilter(zooms, video.width, video.height);
      const master = path.join(directory, "frame.mkv");
      await exportDraft({
        plan,
        profile: "lossless_master",
        outputPath: master,
        replace: false,
        executables: { ffmpeg, ffprobe },
        ...(options.signal ? { signal: options.signal } : {}),
        ...(filter !== null || ass !== undefined || track
          ? {
              compose: {
                filter: filter ?? "",
                ...(track ? { graphics: track } : {}),
                ...(ass !== undefined ? { ass } : {}),
                width: video.width,
                height: video.height,
                pixelFormat: video.pixelFormat,
              },
            }
          : {}),
      });
      const { outWidth, outHeight } = jpegSize(
        video.width,
        video.height,
        options.maxWidth,
      );
      let jpeg: Buffer | null = null;
      // Each remaining picture gets an equal share of what is left, so an
      // early detailed frame cannot starve the last one.
      const share = Math.floor(budget / (options.timesUs.length - index));
      for (const quality of [4, 7, 12, 20]) {
        const result = await runProcess({
          executable: ffmpeg,
          args: [
            "-hide_banner",
            "-loglevel",
            "error",
            "-nostdin",
            "-i",
            master,
            "-frames:v",
            "1",
            "-vf",
            `scale=${outWidth}:${outHeight}:flags=lanczos,format=yuvj420p`,
            "-q:v",
            String(quality),
            "-f",
            "image2",
            "-c:v",
            "mjpeg",
            "pipe:1",
          ],
          timeoutMs: 60_000,
          maxOutputBytes: 8 * 1024 * 1024,
          ...(options.signal ? { signal: options.signal } : {}),
        });
        const encoded = Math.ceil(result.stdout.length / 3) * 4;
        if (result.stdout.length && encoded <= share) {
          jpeg = result.stdout;
          budget -= encoded;
          break;
        }
      }
      if (!jpeg) throw new FrameRenderError("size");
      frames.push({
        timeUs: startUs,
        width: outWidth,
        height: outHeight,
        mimeType: "image/jpeg",
        dataBase64: jpeg.toString("base64"),
      });
      await rm(directory, { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
    return frames;
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}
