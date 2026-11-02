import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
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
  proposeShortCandidates,
  reframeFilter,
  shortSize,
  shortSpeedFits,
  shortTitleBox,
  shortTitleInterval,
  shortWords,
  type ShortCandidate,
  type ShortFormat,
  type ShortProposal,
  type ShortSpeed,
} from "../../../packages/domain/src/short-clips.ts";
import {
  assertShortClipsView,
  shortIssues,
  type ShortClipsView,
  type ShortExportAllRequest,
  type ShortExportOptions,
  type ShortExportRequest,
  type ShortJobView,
  type ShortLibraryItem,
} from "../../../packages/domain/src/short-clips-view.ts";
import { exportDraft } from "../../../packages/media-engine/src/render.ts";
import { planDraft } from "./export.ts";
import type { GraphicsRenderRequest, GraphicsTrack } from "./graphics-track.ts";
import { zoomFilter } from "../../../packages/domain/src/zoom.ts";
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
  /** A folder for exporting every clip; null when the user cancels. */
  chooseFolder(defaultPath: string): Promise<string | null>;
  /** Shows a saved clip in the system file manager. */
  reveal(file: string): void;
  /** True while Claude is running a clip-picking turn for the project. */
  pickRunning(projectId: string): boolean;
  /**
   * Starts Claude's clip-picking turn; throws `ShortClipError` with a plain
   * message when Claude cannot be used. Claude answers through `propose`.
   */
  startPick(projectId: string): Promise<void>;
  ffmpeg?: string;
  ffprobe?: string;
  /** Renders motion graphics into a lossless track (see export). */
  renderGraphics?: (
    request: GraphicsRenderRequest,
  ) => Promise<GraphicsTrack | null>;
}

interface LibraryEntry {
  id: string;
  title: string;
  fileName: string;
  outputPath: string;
  format: ShortFormat;
  speed: ShortSpeed;
  durationUs: number;
  createdAt: string;
}

interface Stored {
  version: 1;
  sequence: number;
  timelineSha256: string;
  candidates: ShortCandidate[];
  discarded: string[];
  /** Clips exported from this project, newest first; absent in older files. */
  library?: LibraryEntry[];
}

const idleJob: ShortJobView = Object.freeze({
  status: "idle",
  clipId: null,
  fraction: null,
  fileName: null,
  message: null,
  batch: null,
});
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{1,127}$/u;
const maxLibrary = 100;

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

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Main-owned short clips: finding candidates in the draft transcript (by
 * rules, or chosen by Claude), remembering discards, exporting clips as MP4s
 * through the verified render pipeline one at a time or all in one folder,
 * and keeping a list of what was exported.
 */
export class DesktopShortClips {
  private readonly options: ShortClipsOptions;
  private job: (ShortJobView & { projectId: string }) | null = null;
  private controller: AbortController | null = null;
  /** What Claude's last clip-picking run did, for the view's message. */
  private pickState: {
    projectId: string;
    proposed: boolean;
    failed: string | null;
  } | null = null;

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
            batch: this.job.batch ? { ...this.job.batch } : null,
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
    const library: ShortLibraryItem[] = [];
    for (const entry of stored?.library ?? [])
      library.push({
        id: entry.id,
        title: entry.title,
        fileName: entry.fileName,
        format: entry.format,
        speed: entry.speed,
        durationUs: entry.durationUs,
        createdAt: entry.createdAt,
        exists: await exists(entry.outputPath),
      });
    const running = this.options.pickRunning(projectId);
    const state =
      this.pickState?.projectId === projectId ? this.pickState : null;
    const value: ShortClipsView = {
      status,
      candidates: (stored?.candidates ?? [])
        .filter((candidate) => !stored!.discarded.includes(candidate.id))
        .map((candidate) => ({
          ...candidate,
          origin: candidate.origin ?? "rules",
        })),
      job: { ...job },
      message,
      library,
      pick: {
        running,
        message:
          running || !state
            ? null
            : (state.failed ?? (state.proposed ? null : shortIssues.pickNone)),
      },
    };
    assertShortClipsView(value);
    return value;
  }

  async find(projectId: string): Promise<ShortClipsView> {
    const draft = await this.options.draftWords(projectId);
    if (!draft.words) throw new ShortClipError(shortIssues.transcript);
    const before = await this.read(projectId);
    this.pickState = null;
    await this.write(projectId, {
      version: 1,
      sequence: draft.sequence,
      timelineSha256: draft.timelineSha256,
      candidates: findShortCandidates(draft.words),
      discarded: [],
      ...(before?.library ? { library: before.library } : {}),
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

  /** Starts Claude choosing clips; it answers through `propose`. */
  async pick(projectId: string): Promise<ShortClipsView> {
    if (this.options.pickRunning(projectId)) return this.view(projectId);
    if (this.busy(projectId)) throw new ShortClipError(shortIssues.busy);
    const draft = await this.options.draftWords(projectId);
    if (!draft.words) throw new ShortClipError(shortIssues.transcript);
    this.pickState = { projectId, proposed: false, failed: null };
    try {
      await this.options.startPick(projectId);
    } catch (error) {
      this.pickState = null;
      throw error;
    }
    return this.view(projectId);
  }

  /**
   * Claude's proposed clips: checked against the draft's words and the same
   * limits the local finder keeps, then stored in place of the earlier set.
   * Returns what was accepted and why anything was refused, so the model can
   * correct it.
   */
  async propose(
    projectId: string,
    proposals: readonly ShortProposal[],
  ): Promise<{ accepted: number; rejected: string[] }> {
    const draft = await this.options.draftWords(projectId);
    if (!draft.words) throw new ShortClipError(shortIssues.transcript);
    const result = proposeShortCandidates(draft.words, proposals);
    if (result.candidates.length === 0)
      return { accepted: 0, rejected: result.rejected };
    const before = await this.read(projectId);
    await this.write(projectId, {
      version: 1,
      sequence: draft.sequence,
      timelineSha256: draft.timelineSha256,
      candidates: result.candidates,
      discarded: [],
      ...(before?.library ? { library: before.library } : {}),
    });
    this.pickState = { projectId, proposed: true, failed: null };
    return { accepted: result.candidates.length, rejected: result.rejected };
  }

  /** Draft words and the stored set, checked to belong to the current head. */
  private async current(projectId: string): Promise<{
    stored: Stored;
    words: CaptionWord[] | null;
  }> {
    const stored = await this.read(projectId);
    if (!stored) throw new ShortClipError(shortIssues.unknown);
    const draft = await this.options.draftWords(projectId);
    if (
      draft.sequence !== stored.sequence ||
      draft.timelineSha256 !== stored.timelineSha256
    )
      throw new ShortClipError(shortIssues.stale);
    return { stored, words: draft.words };
  }

  /** Refuses a speed some part of the clip cannot play. */
  private async checkSpeed(
    projectId: string,
    candidate: ShortCandidate,
    speed: ShortSpeed,
  ): Promise<void> {
    if (speed === 1) return;
    const { draft } = await this.options.drafts.snapshotWithProject(projectId);
    const speeds = draft.timeline.clips
      .filter(
        (clip) =>
          clip.enabled &&
          clip.timeline_start_us < candidate.endUs &&
          clip.timeline_end_us > candidate.startUs,
      )
      .map((clip) => clip.speed);
    if (!shortSpeedFits(speeds, speed))
      throw new ShortClipError(shortIssues.speed);
  }

  /**
   * Renders one clip to `outputPath` through the verified pipeline. Throws on
   * failure; the caller decides what the job shows.
   */
  private async renderClip(input: {
    projectId: string;
    candidate: ShortCandidate;
    words: CaptionWord[] | null;
    options: ShortExportOptions;
    outputPath: string;
    signal: AbortSignal;
    onProgress: (fraction: number) => void;
  }): Promise<void> {
    const { projectId, candidate, words, options, signal } = input;
    const { plan, zooms, graphics } = await planDraft(
      this.options.drafts,
      this.options.ffprobe ?? "ffprobe",
      projectId,
      {
        startUs: candidate.startUs,
        endUs: candidate.endUs,
        speed: options.speed,
      },
    );
    const { width, height } = shortSize(options.format);
    let ass: string | undefined;
    if (options.captions && words) {
      const cues = buildCaptionCues(
        // Spoken times move with the clip's speed.
        shortWords(words, candidate.startUs, candidate.endUs).map((word) => ({
          ...word,
          startUs: Math.floor(word.startUs / options.speed),
          endUs: Math.floor(word.endUs / options.speed),
        })),
        // Narrow formats need shorter lines.
        {
          maxLineChars: options.format === "landscape" ? 42 : 26,
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
          marginFraction: options.format === "vertical" ? 0.2 : 0.08,
        });
    }
    const title = options.title
      ? shortTitleInterval(
          candidate.title,
          candidate.endUs - candidate.startUs,
          shortTitleBox(
            options.format,
            options.framing,
            options.position,
            plan.format.video,
          ),
          options.speed,
        )
      : null;
    const drawn = title ? [...graphics, title] : graphics;
    const audioCleanup = await this.options.audioSettings(projectId);
    let scratch: string | null = null;
    try {
      // Graphics are drawn at the recording's size, before reframing.
      let track: GraphicsTrack | null = null;
      if (drawn.length) {
        if (!this.options.renderGraphics)
          throw new ShortClipError(shortIssues.failed);
        scratch = await mkdtemp(
          path.join(tmpdir(), "ai-video-editor-graphics-"),
        );
        track = await this.options.renderGraphics({
          intervals: drawn,
          width: plan.format.video.width,
          height: plan.format.video.height,
          frameRate: plan.format.video.frameRate,
          frameCount: plan.frameCount,
          directory: scratch,
          ffmpeg: this.options.ffmpeg ?? "ffmpeg",
          signal,
        });
      }
      await exportDraft({
        plan,
        profile: "smaller_mp4",
        outputPath: input.outputPath,
        // The save dialog asked before replacing an existing file.
        replace: true,
        signal,
        audioCleanup,
        compose: {
          // Zooms apply to the full frame first, then graphics are drawn,
          // then the frame is reframed.
          filter:
            zoomFilter(
              zooms,
              plan.format.video.width,
              plan.format.video.height,
            ) ?? "",
          ...(track ? { graphics: track } : {}),
          after: reframeFilter(
            options.format,
            options.framing,
            options.position,
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
        onProgress: (progress) =>
          input.onProgress(Math.round(progress.fraction * 1000) / 1000),
      });
    } finally {
      if (scratch) await rm(scratch, { recursive: true, force: true });
    }
  }

  /** Records a saved clip in the project's list, newest first. */
  private async remember(
    projectId: string,
    candidate: ShortCandidate,
    options: ShortExportOptions,
    outputPath: string,
  ): Promise<void> {
    const stored = await this.read(projectId);
    if (!stored) return;
    const entry: LibraryEntry = {
      id: `export-${randomUUID()}`,
      title: candidate.title,
      fileName: path.basename(outputPath),
      outputPath,
      format: options.format,
      speed: options.speed,
      durationUs: Math.round(
        (candidate.endUs - candidate.startUs) / options.speed,
      ),
      createdAt: new Date().toISOString(),
    };
    stored.library = [
      entry,
      // A clip saved again over the same file replaces its entry.
      ...(stored.library ?? []).filter(
        (other) => other.outputPath !== outputPath,
      ),
    ].slice(0, maxLibrary);
    await this.write(projectId, stored);
  }

  async export(request: ShortExportRequest): Promise<ShortClipsView> {
    const projectId = request.project_id;
    if (this.busy()) throw new ShortClipError(shortIssues.busy);
    const { stored, words } = await this.current(projectId);
    const candidate = stored.candidates.find(
      (item) => item.id === request.clip_id,
    );
    if (!candidate) throw new ShortClipError(shortIssues.unknown);
    await this.checkSpeed(projectId, candidate, request.speed);
    const chosen = await this.options.chooseDestination(
      path.join(
        this.options.defaultDirectory(),
        `${safeName(candidate.title)}.mp4`,
      ),
    );
    if (!chosen) return this.view(projectId);
    const outputPath =
      path.extname(chosen).toLowerCase() === ".mp4" ? chosen : `${chosen}.mp4`;
    const controller = new AbortController();
    this.controller = controller;
    const job = {
      projectId,
      status: "running" as const,
      clipId: candidate.id,
      fraction: 0,
      fileName: path.basename(outputPath),
      message: null,
      batch: null,
    };
    this.job = job;
    void (async () => {
      try {
        await this.renderClip({
          projectId,
          candidate,
          words,
          options: request,
          outputPath,
          signal: controller.signal,
          onProgress: (fraction) => {
            if (this.job === job) job.fraction = fraction;
          },
        });
        await this.remember(projectId, candidate, request, outputPath).catch(
          () => undefined,
        );
        if (this.job === job)
          this.job = { ...job, status: "completed", fraction: null };
      } catch {
        if (this.job === job)
          this.job = {
            ...job,
            status: "failed",
            fraction: null,
            fileName: null,
            message: controller.signal.aborted ? null : shortIssues.failed,
          };
      }
    })();
    return this.view(projectId);
  }

  /** Exports every clip in a chosen folder, one after another. */
  async exportAll(request: ShortExportAllRequest): Promise<ShortClipsView> {
    const projectId = request.project_id;
    if (this.busy()) throw new ShortClipError(shortIssues.busy);
    const { stored, words } = await this.current(projectId);
    const candidates = stored.candidates.filter(
      (item) =>
        !stored.discarded.includes(item.id) &&
        (request.clip_ids === undefined || request.clip_ids.includes(item.id)),
    );
    if (candidates.length === 0) throw new ShortClipError(shortIssues.noClips);
    for (const candidate of candidates)
      await this.checkSpeed(projectId, candidate, request.speed);
    const folder = await this.options.chooseFolder(
      this.options.defaultDirectory(),
    );
    if (!folder) return this.view(projectId);
    // One file per clip, named for its title; a repeated name gets a number.
    const used = new Set<string>();
    const targets: { candidate: ShortCandidate; outputPath: string }[] = [];
    for (const candidate of candidates) {
      const base = safeName(candidate.title);
      let name = `${base}.mp4`;
      for (
        let n = 2;
        used.has(name) || (await exists(path.join(folder, name)));
        n++
      )
        name = `${base} (${n}).mp4`;
      used.add(name);
      targets.push({ candidate, outputPath: path.join(folder, name) });
    }
    const controller = new AbortController();
    this.controller = controller;
    const job: ShortJobView & { projectId: string } = {
      projectId,
      status: "running",
      clipId: targets[0]!.candidate.id,
      fraction: 0,
      fileName: path.basename(targets[0]!.outputPath),
      message: null,
      batch: { index: 0, total: targets.length },
    };
    this.job = job;
    void (async () => {
      try {
        for (const [index, target] of targets.entries()) {
          if (this.job !== job) return;
          job.clipId = target.candidate.id;
          job.fileName = path.basename(target.outputPath);
          job.fraction = 0;
          job.batch = { index, total: targets.length };
          await this.renderClip({
            projectId,
            candidate: target.candidate,
            words,
            options: request,
            outputPath: target.outputPath,
            signal: controller.signal,
            onProgress: (fraction) => {
              if (this.job === job) job.fraction = fraction;
            },
          });
          await this.remember(
            projectId,
            target.candidate,
            request,
            target.outputPath,
          ).catch(() => undefined);
        }
        if (this.job === job)
          this.job = {
            ...job,
            status: "completed",
            fraction: null,
            batch: { index: targets.length - 1, total: targets.length },
          };
      } catch {
        if (this.job === job)
          this.job = {
            ...job,
            status: "failed",
            fraction: null,
            fileName: null,
            message: controller.signal.aborted ? null : shortIssues.failed,
          };
      }
    })();
    return this.view(projectId);
  }

  /** Shows a saved clip in the file manager. */
  async reveal(projectId: string, exportId: string): Promise<ShortClipsView> {
    const entry = (await this.read(projectId))?.library?.find(
      (item) => item.id === exportId,
    );
    if (!entry) throw new ShortClipError(shortIssues.libraryUnknown);
    if (await exists(entry.outputPath)) this.options.reveal(entry.outputPath);
    return this.view(projectId);
  }

  /** Takes a clip off the list; the file is not touched. */
  async forget(projectId: string, exportId: string): Promise<ShortClipsView> {
    const stored = await this.read(projectId);
    if (stored?.library?.some((item) => item.id === exportId)) {
      stored.library = stored.library.filter((item) => item.id !== exportId);
      await this.write(projectId, stored);
    }
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
