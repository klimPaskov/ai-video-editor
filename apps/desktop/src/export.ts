import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  toAss,
  toSrt,
  type CaptionCue,
  type CaptionSettings,
} from "../../../packages/domain/src/captions.ts";
import {
  defaultAudioSettings,
  type AudioSettings,
} from "../../../packages/domain/src/audio-settings.ts";
import {
  access,
  mkdir,
  mkdtemp,
  open,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  assertExportView,
  exportIssues,
  exportUnsupported,
  idleExportView,
  type ExportProfileChoice,
  type ExportView,
} from "../../../packages/domain/src/export-view.ts";
import { MediaError } from "../../../packages/media-engine/src/process.ts";
import { draftWindowClips } from "../../../packages/domain/src/short-clips.ts";
import {
  windowZoomIntervals,
  zoomFilter,
  zoomIntervals,
  type ZoomInterval,
} from "../../../packages/domain/src/zoom.ts";
import {
  graphicIntervals,
  type GraphicInterval,
} from "../../../packages/domain/src/graphics.ts";
import type { GraphicsRenderRequest, GraphicsTrack } from "./graphics-track.ts";
import { probePresentationTiming } from "../../../packages/media-engine/src/presentation-timing.ts";
import {
  exportDraft,
  planExport,
  type ExportComposition,
  type ExportEvidence,
  type ExportSource,
} from "../../../packages/media-engine/src/render.ts";
import type { DraftProjectReadResult } from "../../../packages/project-store/src/transactions.ts";

type DraftReader = {
  snapshotWithProject(projectId: string): Promise<DraftProjectReadResult>;
};

export interface DesktopExportOptions {
  drafts: DraftReader;
  /** Directory for delivery manifests (never shown to the renderer). */
  recordRoot: string;
  /** Default folder offered by the save dialog. */
  defaultDirectory: () => string;
  /** Main-owned save dialog; null when the user cancels. */
  chooseDestination: (options: {
    defaultPath: string;
    profile: ExportProfileChoice;
  }) => Promise<string | null>;
  showInFolder: (file: string) => void;
  openFile: (file: string) => Promise<void>;
  ffmpeg?: string;
  ffprobe?: string;
  /** Captions for the project's current draft, or null when off. */
  captions?: (
    projectId: string,
  ) => Promise<{ cues: CaptionCue[]; settings: CaptionSettings } | null>;
  /** Audio cleanup chosen for the project. */
  audio?: (projectId: string) => Promise<AudioSettings>;
  /**
   * Renders motion graphics into a lossless track (Electron offscreen
   * rendering in the app). Without it, drafts with graphics cannot export.
   */
  renderGraphics?: (
    request: GraphicsRenderRequest,
  ) => Promise<GraphicsTrack | null>;
}

interface Job {
  projectId: string;
  profile: ExportProfileChoice;
  controller: AbortController;
  outputPath: string;
  draftSequence: number;
  captions: { cues: CaptionCue[]; settings: CaptionSettings } | null;
  audio: AudioSettings;
  zooms: ZoomInterval[];
  graphics: GraphicInterval[];
}

const unsupportedSet = new Set<string>(exportUnsupported);

function safeName(name: string): string {
  const base = name
    .replace(/\.[A-Za-z0-9]{1,5}$/u, "")
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 120);
  return base || "Video";
}

/**
 * Plans the export of the active draft, or of output time [startUs, endUs)
 * of it when a window is given. Throws `MediaError` with a fixed message.
 */
export async function planDraft(
  drafts: DraftReader,
  ffprobe: string,
  projectId: string,
  window?: { startUs: number; endUs: number },
): Promise<{
  plan: ReturnType<typeof planExport>;
  snapshot: DraftProjectReadResult;
  /** The draft's zooms in the exported output's own time. */
  zooms: ZoomInterval[];
  /** The draft's graphics in the exported output's own time. */
  graphics: GraphicInterval[];
}> {
  const snapshot = await drafts.snapshotWithProject(projectId);
  const project = snapshot.project;
  const sources =
    project.schema_version === "1.1" ? project.sources : [project.source];
  const probes =
    project.schema_version === "1.1"
      ? project.source_probes
      : [project.source_probe];
  const ordered = [...snapshot.draft.timeline.clips]
    .filter((clip) => clip.enabled)
    .sort((a, b) => a.timeline_start_us - b.timeline_start_us);
  const mapped = ordered.map((clip) => ({
    sourceId: clip.source_id,
    timelineStartUs: clip.timeline_start_us,
    timelineEndUs: clip.timeline_end_us,
    sourceStartUs: clip.source_start_us,
    sourceEndUs: clip.source_end_us,
    ...(clip.speed ? { speed: clip.speed } : {}),
  }));
  const allZooms = zoomIntervals(snapshot.draft.timeline.zooms ?? [], mapped);
  const zooms = window
    ? windowZoomIntervals(allZooms, window.startUs, window.endUs)
    : allZooms;
  const allGraphics = graphicIntervals(
    snapshot.draft.timeline.graphics ?? [],
    mapped,
    snapshot.draft.timeline.duration_us,
  );
  const graphics = window
    ? allGraphics
        .filter(
          (item) => item.endUs > window.startUs && item.startUs < window.endUs,
        )
        .map((item) => ({
          ...item,
          startUs: item.startUs - window.startUs,
          endUs: item.endUs - window.startUs,
        }))
    : allGraphics;
  const clips = window
    ? draftWindowClips(mapped, window.startUs, window.endUs)
    : ordered.map((clip) => ({
        sourceId: clip.source_id,
        sourceStartUs: clip.source_start_us,
        sourceEndUs: clip.source_end_us,
        ...(clip.speed ? { speed: clip.speed } : {}),
      }));
  const used = new Set(clips.map((clip) => clip.sourceId));
  const exportSources: ExportSource[] = [];
  for (const [index, source] of sources.entries()) {
    if (!used.has(source.source_id)) continue;
    const probe = probes[index]! as Record<string, unknown>;
    const video = (
      probe.streams as Record<string, unknown>[] | undefined
    )?.find((stream) => stream.codec_type === "video");
    if (!video)
      throw new MediaError("UNSUPPORTED_PROFILE", exportUnsupported[15]);
    exportSources.push({
      sourceId: source.source_id,
      path: source.managed_path,
      sha256: source.sha256,
      probe,
      timing: await probePresentationTiming(
        ffprobe,
        source.managed_path,
        video,
      ),
    });
  }
  return { plan: planExport(clips, exportSources), snapshot, zooms, graphics };
}

/**
 * Zooms and burned-in captions drawn into the frames at the draft's own size
 * and pixel format. Frames neither touches stay bit-identical.
 */
function composition(
  job: Job,
  video: { width: number; height: number; pixelFormat: string },
  graphics: GraphicsTrack | null,
): { compose: ExportComposition } | Record<string, never> {
  const filter = zoomFilter(job.zooms, video.width, video.height);
  const ass = job.captions?.settings.burnIn
    ? toAss(job.captions.cues, job.captions.settings, video.width, video.height)
    : undefined;
  if (filter === null && ass === undefined && !graphics) return {};
  return {
    compose: {
      filter: filter ?? "",
      ...(graphics ? { graphics } : {}),
      ...(ass !== undefined ? { ass } : {}),
      width: video.width,
      height: video.height,
      pixelFormat: video.pixelFormat,
    },
  };
}

/**
 * Main-owned export: one job at a time, destination chosen through the
 * system save dialog, verified render before the file appears.
 */
export class DesktopExports {
  private readonly options: DesktopExportOptions;
  private view: ExportView = idleExportView();
  private job: Job | null = null;
  private lastOutput: string | null = null;

  constructor(options: DesktopExportOptions) {
    this.options = options;
  }

  get(projectId: string): ExportView {
    const value =
      this.view.projectId === projectId
        ? structuredClone(this.view)
        : idleExportView();
    assertExportView(value);
    return value;
  }

  busy(projectId?: string): boolean {
    return Boolean(
      this.job && (!projectId || this.job.projectId === projectId),
    );
  }

  private set(next: ExportView): void {
    assertExportView(next);
    this.view = next;
  }

  async start(
    projectId: string,
    profile: ExportProfileChoice,
  ): Promise<ExportView> {
    if (this.job) {
      if (this.job.projectId === projectId) return this.get(projectId);
      throw new MediaError("INVALID_INPUT", exportIssues.busy);
    }
    let draft: Awaited<ReturnType<typeof planDraft>>;
    try {
      draft = await planDraft(
        this.options.drafts,
        this.options.ffprobe ?? "ffprobe",
        projectId,
      );
    } catch (error) {
      this.fail(projectId, profile, error);
      return this.get(projectId);
    }
    const { plan, snapshot, zooms, graphics } = draft;
    const project = snapshot.project;
    const extension = profile === "lossless_master" ? ".mkv" : ".mp4";
    const suffix = profile === "lossless_master" ? "master" : "share";
    const chosen = await this.options.chooseDestination({
      defaultPath: path.join(
        this.options.defaultDirectory(),
        `${safeName(project.project.name)} ${suffix}${extension}`,
      ),
      profile,
    });
    if (!chosen) return this.get(projectId);
    const outputPath =
      path.extname(chosen).toLowerCase() === extension
        ? chosen
        : `${chosen}${extension}`;
    let replace = false;
    try {
      await access(outputPath, constants.F_OK);
      // The system dialog asked the user to confirm replacing this file.
      replace = path.resolve(outputPath) === path.resolve(chosen);
      if (!replace) throw new MediaError("INVALID_INPUT", exportIssues.failed);
    } catch (error) {
      if (error instanceof MediaError) {
        this.fail(projectId, profile, error);
        return this.get(projectId);
      }
    }
    // Captions are fixed when the export starts, like the draft itself.
    const captions = await this.options.captions?.(projectId).catch(() => null);
    const audio =
      (await this.options.audio?.(projectId).catch(() => null)) ??
      defaultAudioSettings;
    const controller = new AbortController();
    const job: Job = {
      audio,
      captions: captions && captions.cues.length ? captions : null,
      zooms,
      graphics,
      projectId,
      profile,
      controller,
      outputPath,
      draftSequence: snapshot.draft.draft_sequence,
    };
    this.job = job;
    this.set({
      status: "running",
      projectId,
      profile,
      phase: "rendering",
      fraction: 0,
      result: null,
      message: null,
    });
    void this.run(job, plan, replace);
    return this.get(projectId);
  }

  private async run(
    job: Job,
    plan: ReturnType<typeof planExport>,
    replace: boolean,
  ): Promise<void> {
    let evidence: ExportEvidence;
    let scratch: string | null = null;
    try {
      // Graphics are rendered first, then composed over the frames.
      let graphics: GraphicsTrack | null = null;
      if (job.graphics.length) {
        if (!this.options.renderGraphics)
          throw new MediaError("UNSUPPORTED_PROFILE", exportIssues.failed);
        scratch = await mkdtemp(
          path.join(tmpdir(), "ai-video-editor-graphics-"),
        );
        graphics = await this.options.renderGraphics({
          intervals: job.graphics,
          width: plan.format.video.width,
          height: plan.format.video.height,
          frameRate: plan.format.video.frameRate,
          frameCount: plan.frameCount,
          directory: scratch,
          ffmpeg: this.options.ffmpeg ?? "ffmpeg",
          signal: job.controller.signal,
          onProgress: (fraction) => {
            if (this.job !== job || this.view.status !== "running") return;
            this.set({
              ...this.view,
              phase: "rendering",
              fraction: Math.round(fraction * 250) / 1000,
            });
          },
        });
      }
      const share = graphics ? 0.75 : 1;
      evidence = await exportDraft({
        plan,
        profile: job.profile,
        outputPath: job.outputPath,
        replace,
        executables: {
          ffmpeg: this.options.ffmpeg ?? "ffmpeg",
          ffprobe: this.options.ffprobe ?? "ffprobe",
        },
        signal: job.controller.signal,
        audioCleanup: job.audio,
        ...composition(job, plan.format.video, graphics),
        onProgress: (progress) => {
          if (this.job !== job || this.view.status !== "running") return;
          this.set({
            ...this.view,
            phase: progress.phase,
            fraction:
              Math.round((1 - share + progress.fraction * share) * 1000) / 1000,
          });
        },
      });
    } catch (error) {
      if (this.job === job) {
        this.job = null;
        this.fail(job.projectId, job.profile, error);
      }
      return;
    } finally {
      if (scratch) await rm(scratch, { recursive: true, force: true });
    }
    let message: string | null = null;
    try {
      await this.record(job, evidence);
    } catch {
      message = exportIssues.storage;
    }
    // Captions are a sidecar beside the video; a failure never loses the
    // verified video, and an unrelated existing file is not replaced.
    let captionsFileName: string | null = null;
    try {
      const text = job.captions ? toSrt(job.captions.cues) : null;
      if (text) {
        const file = job.outputPath.replace(/\.[^.\\/]+$/u, "") + ".srt";
        await writeFile(file, text, { flag: replace ? "w" : "wx" });
        captionsFileName = path.basename(file);
      }
    } catch {
      captionsFileName = null;
    }
    if (this.job !== job) return;
    this.job = null;
    this.lastOutput = job.outputPath;
    this.set({
      status: "completed",
      projectId: job.projectId,
      profile: job.profile,
      phase: null,
      fraction: null,
      result: {
        fileName: path.basename(job.outputPath),
        profile: job.profile,
        durationUs: evidence.durationUs,
        frameCount: evidence.frameCount,
        outputBytes: evidence.outputBytes,
        samplesEqual: evidence.samplesEqual,
        draftSequence: job.draftSequence,
        captionsFileName,
        captionsBurnedIn: job.captions?.settings.burnIn === true,
        audioCleaned:
          plan.format.audio !== null &&
          (job.audio.normalize || job.audio.denoise),
      },
      message,
    });
  }

  /** Delivery manifest: the exact render, its verification and the draft. */
  private async record(job: Job, evidence: ExportEvidence): Promise<void> {
    const directory = path.join(this.options.recordRoot, job.projectId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const exportId = `export-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const target = path.join(directory, `${exportId}.json`);
    const temporary = `${target}.${randomUUID()}.tmp`;
    const file = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    try {
      await file.writeFile(
        JSON.stringify(
          {
            schema_version: "1.0",
            export_id: exportId,
            project_id: job.projectId,
            draft_sequence: job.draftSequence,
            created_at: new Date().toISOString(),
            output_path: job.outputPath,
            evidence,
          },
          null,
          2,
        ),
      );
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, target).catch(async (error: unknown) => {
      await rm(temporary, { force: true });
      throw error;
    });
  }

  private fail(
    projectId: string,
    profile: ExportProfileChoice,
    error: unknown,
  ): void {
    const message =
      error instanceof MediaError
        ? error.code === "CANCELLED"
          ? exportIssues.cancelled
          : error.code === "FIDELITY_MISMATCH"
            ? exportIssues.verification
            : error.code === "PROCESS_UNAVAILABLE"
              ? exportIssues.tools
              : unsupportedSet.has(error.message) ||
                  Object.values(exportIssues).includes(
                    error.message as (typeof exportIssues)[keyof typeof exportIssues],
                  )
                ? error.message
                : exportIssues.failed
        : exportIssues.failed;
    this.set({
      status: "failed",
      projectId,
      profile,
      phase: null,
      fraction: null,
      result: null,
      message,
    });
  }

  cancel(projectId: string): ExportView {
    if (this.job?.projectId === projectId && this.view.status === "running") {
      this.set({ ...this.view, status: "cancelling", phase: null });
      this.job.controller.abort();
    }
    return this.get(projectId);
  }

  /** Clears a finished or failed export so the panel offers a new one. */
  reset(projectId: string): ExportView {
    if (!this.job && this.view.projectId === projectId)
      this.view = idleExportView();
    return this.get(projectId);
  }

  reveal(projectId: string): void {
    if (
      this.view.status === "completed" &&
      this.view.projectId === projectId &&
      this.lastOutput
    )
      this.options.showInFolder(this.lastOutput);
  }

  async openResult(projectId: string): Promise<void> {
    if (
      this.view.status === "completed" &&
      this.view.projectId === projectId &&
      this.lastOutput
    )
      await this.options.openFile(this.lastOutput);
  }

  async close(): Promise<void> {
    this.job?.controller.abort();
  }
}
