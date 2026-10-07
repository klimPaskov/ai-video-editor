import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AudioSettings } from "../../../packages/domain/src/audio-settings.ts";
import {
  buildCaptionCues,
  toAss,
  type CaptionSettings,
  type CaptionWord,
} from "../../../packages/domain/src/captions.ts";
import {
  findShortCandidates,
  reframeFilter,
  shortSize,
  shortWords,
  type ShortCandidate,
} from "../../../packages/domain/src/short-clips.ts";
import {
  assertShortClipsView,
  shortIssues,
  type ShortClipsView,
  type ShortExportRequest,
  type ShortJobView,
} from "../../../packages/domain/src/short-clips-view.ts";
import { exportDraft } from "../../../packages/media-engine/src/render.ts";
import { planDraft } from "./export.ts";
import type { DraftProjectReadResult } from "../../../packages/project-store/src/transactions.ts";

export class ShortClipError extends Error {}

/** The draft as captions see it: output-time words and the draft head. */
export interface DraftWords {
  words: CaptionWord[] | null;
  sequence: number;
  timelineSha256: string;
}

export interface ShortClipsOptions {
  root: string;
  drafts: {
    snapshotWithProject(projectId: string): Promise<DraftProjectReadResult>;
  };
  draftWords(projectId: string): Promise<DraftWords>;
  captionSettings(projectId: string): Promise<CaptionSettings>;
  audioSettings(projectId: string): Promise<AudioSettings>;
  defaultDirectory(): string;
  chooseDestination(defaultPath: string): Promise<string | null>;
  ffmpeg?: string;
  ffprobe?: string;
}

interface Stored {
  version: 1;
  sequence: number;
  timelineSha256: string;
  candidates: ShortCandidate[];
  discarded: string[];
}

const idleJob: ShortJobView = Object.freeze({
  status: "idle",
  clipId: null,
  fraction: null,
  fileName: null,
  message: null,
});
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{1,127}$/u;

function safeName(title: string): string {
  return (
    title
      .replace(/[\\/:*?"<>|\u0000-\u001f\u007f…]/gu, " ")
      .replace(/\s+/gu, " ")
      .trim()
      .slice(0, 80)
      .trim() || "Clip"
  );
}

/**
 * Main-owned short clips: finding candidates in the draft transcript,
 * remembering discards, and exporting one clip at a time as an MP4 through
 * the verified render pipeline.
 */
export class DesktopShortClips {
  private readonly options: ShortClipsOptions;
  private job: (ShortJobView & { projectId: string }) | null = null;
  private controller: AbortController | null = null;

  constructor(options: ShortClipsOptions) {
    this.options = options;
  }

  private file(projectId: string): string {
    if (!idPattern.test(projectId)) throw new Error("Invalid project.");
    return path.join(this.options.root, `${projectId}.json`);
  }

  private async read(projectId: string): Promise<Stored | null> {
    try {
      const value = JSON.parse(
        await readFile(this.file(projectId), "utf8"),
      ) as Stored;
      return value?.version === 1 && Array.isArray(value.candidates)
        ? value
        : null;
    } catch {
      return null;
    }
  }

  private async write(projectId: string, value: Stored): Promise<void> {
    await mkdir(this.options.root, { recursive: true, mode: 0o700 });
    const file = this.file(projectId);
    const staged = `${file}.${process.pid}.tmp`;
    await writeFile(staged, JSON.stringify(value), { mode: 0o600 });
    await rename(staged, file);
  }

  busy(projectId?: string): boolean {
    return (
      this.job?.status === "running" &&
      (!projectId || this.job.projectId === projectId)
    );
  }

  async view(projectId: string): Promise<ShortClipsView> {
    const stored = await this.read(projectId);
    const job =
      this.job?.projectId === projectId
        ? {
            status: this.job.status,
            clipId: this.job.clipId,
            fraction: this.job.fraction,
            fileName: this.job.fileName,
            message: this.job.message,
          }
        : idleJob;
    let status: ShortClipsView["status"] = "none";
    let message: string | null = null;
    if (stored) {
      const head = await this.options.draftWords(projectId);
      status =
        head.sequence === stored.sequence &&
        head.timelineSha256 === stored.timelineSha256
          ? "ready"
          : "stale";
      if (status === "stale") message = shortIssues.stale;
      else if (stored.candidates.length === 0) message = shortIssues.none;
    }
    const value: ShortClipsView = {
      status,
      candidates: (stored?.candidates ?? []).filter(
        (candidate) => !stored!.discarded.includes(candidate.id),
      ),
      job: { ...job },
      message,
    };
    assertShortClipsView(value);
    return value;
  }

  async find(projectId: string): Promise<ShortClipsView> {
    const draft = await this.options.draftWords(projectId);
    if (!draft.words) throw new ShortClipError(shortIssues.transcript);
    await this.write(projectId, {
      version: 1,
      sequence: draft.sequence,
      timelineSha256: draft.timelineSha256,
      candidates: findShortCandidates(draft.words),
      discarded: [],
    });
    return this.view(projectId);
  }

  async discard(projectId: string, clipId: string): Promise<ShortClipsView> {
    const stored = await this.read(projectId);
    if (stored && !stored.discarded.includes(clipId)) {
      stored.discarded.push(clipId);
      await this.write(projectId, stored);
    }
    return this.view(projectId);
  }

  async export(request: ShortExportRequest): Promise<ShortClipsView> {
    const projectId = request.project_id;
    if (this.busy()) throw new ShortClipError(shortIssues.busy);
    const stored = await this.read(projectId);
    const candidate = stored?.candidates.find(
      (item) => item.id === request.clip_id,
    );
    if (!stored || !candidate) throw new ShortClipError(shortIssues.unknown);
    const draft = await this.options.draftWords(projectId);
    if (
      draft.sequence !== stored.sequence ||
      draft.timelineSha256 !== stored.timelineSha256
    )
      throw new ShortClipError(shortIssues.stale);
    const chosen = await this.options.chooseDestination(
      path.join(
        this.options.defaultDirectory(),
        `${safeName(candidate.title)}.mp4`,
      ),
    );
    if (!chosen) return this.view(projectId);
    const outputPath =
      path.extname(chosen).toLowerCase() === ".mp4" ? chosen : `${chosen}.mp4`;
    const { plan } = await planDraft(
      this.options.drafts,
      this.options.ffprobe ?? "ffprobe",
      projectId,
      { startUs: candidate.startUs, endUs: candidate.endUs },
    );
    const { width, height } = shortSize(request.format);
    let ass: string | undefined;
    if (request.captions && draft.words) {
      const cues = buildCaptionCues(
        shortWords(draft.words, candidate.startUs, candidate.endUs),
        // Narrow formats need shorter lines.
        {
          maxLineChars: request.format === "landscape" ? 42 : 26,
          maxLines: 2,
          maxDurationUs: 4_000_000,
          pauseUs: 600_000,
          minDurationUs: 600_000,
          holdUs: 300_000,
        },
      );
      const settings = await this.options.captionSettings(projectId);
      if (cues.length)
        ass = toAss(cues, { ...settings, position: "bottom" }, width, height, {
          // Clear of the controls social apps draw at the bottom.
          marginFraction: request.format === "vertical" ? 0.2 : 0.08,
        });
    }
    const controller = new AbortController();
    this.controller = controller;
    const job = {
      projectId,
      status: "running" as const,
      clipId: candidate.id,
      fraction: 0,
      fileName: path.basename(outputPath),
      message: null,
    };
    this.job = job;
    void exportDraft({
      plan,
      profile: "smaller_mp4",
      outputPath,
      // The save dialog asked before replacing an existing file.
      replace: true,
      signal: controller.signal,
      audioCleanup: await this.options.audioSettings(projectId),
      compose: {
        filter: reframeFilter(
          request.format,
          request.framing,
          request.position,
        ),
        ...(ass !== undefined ? { ass } : {}),
        width,
        height,
        pixelFormat: "yuv420p",
        color: {
          range: "tv",
          space: "bt709",
          primaries: "bt709",
          transfer: "bt709",
        },
      },
      executables: {
        ffmpeg: this.options.ffmpeg ?? "ffmpeg",
        ffprobe: this.options.ffprobe ?? "ffprobe",
      },
      onProgress: (progress) => {
        if (this.job === job)
          job.fraction = Math.round(progress.fraction * 1000) / 1000;
      },
    }).then(
      () => {
        if (this.job === job)
          this.job = { ...job, status: "completed", fraction: null };
      },
      () => {
        if (this.job === job)
          this.job = {
            ...job,
            status: "failed",
            fraction: null,
            fileName: null,
            message: controller.signal.aborted ? null : shortIssues.failed,
          };
      },
    );
    return this.view(projectId);
  }

  cancel(projectId: string): Promise<ShortClipsView> {
    if (this.busy(projectId)) this.controller?.abort();
    return this.view(projectId);
  }

  close(): void {
    this.controller?.abort();
  }
}
