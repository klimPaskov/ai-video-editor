import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  captureSize,
  parseDshowAudio,
  parsePulseSources,
  testToneInput,
  type AudioInput,
  type CapturePlatform,
  type DisplayTarget,
} from "../../../packages/recorder/src/capture.ts";
import { CaptureSession } from "../../../packages/recorder/src/session.ts";
import type { MediaSummary } from "../../../packages/domain/src/library.ts";
import {
  assertRecordingDevices,
  assertRecordingRegion,
  assertRecordingView,
  minimumRegionSize,
  recordingIssues,
  type RecordingDevices,
  type RecordingRegion,
  type RecordingStartRequest,
  type RecordingView,
} from "../../../packages/domain/src/recording-view.ts";

export class RecordingError extends Error {}

/** A display as Electron reports it, already in physical pixels. */
export interface PhysicalDisplay {
  id: string;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  primary: boolean;
}

export interface RecorderOptions {
  root: string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  ffmpeg?: string;
  ffprobe?: string;
  displays(): PhysicalDisplay[];
  importFile(path: string): Promise<MediaSummary>;
  /** Overridable for tests; lists capture microphones. */
  listOutput?(executable: string, args: string[]): Promise<string>;
  /**
   * Lets the user drag out an area of a display. Resolves to the area as
   * fractions of the display (0..1), or null when cancelled.
   */
  pickArea?(
    displayId: string,
  ): Promise<{ x: number; y: number; width: number; height: number } | null>;
}

function output(executable: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      executable,
      args,
      { timeout: 10_000, windowsHide: true, maxBuffer: 1024 * 1024 },
      (_error, stdout, stderr) => resolve(`${stdout}\n${stderr}`),
    );
  });
}

/** "Recording 2026-10-07 14.32" in local time; valid on every platform. */
export function takeName(date: Date): string {
  const two = (value: number) => String(value).padStart(2, "0");
  return `Recording ${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}.${two(date.getMinutes())}`;
}

const idle: RecordingView = Object.freeze({
  status: "idle",
  elapsedUs: 0,
  missedFrames: 0,
  media: null,
  message: null,
});

/**
 * Main-owned screen recording. The renderer chooses a display and microphone
 * by opaque id; capture runs through FFmpeg into a lossless take, which is
 * imported into the media library like any other source when it stops.
 */
export class DesktopRecorder {
  private readonly options: RecorderOptions;
  private readonly ffmpeg: string;
  private readonly ffprobe: string;
  private displays = new Map<string, DisplayTarget>();
  private microphones = new Map<string, AudioInput>();
  private session: CaptureSession | null = null;
  private directory: string | null = null;
  private view: RecordingView = idle;
  private wantRecording = false;

  constructor(options: RecorderOptions) {
    this.options = options;
    this.ffmpeg = options.ffmpeg ?? "ffmpeg";
    this.ffprobe = options.ffprobe ?? "ffprobe";
  }

  private testCapture(): boolean {
    return this.options.env.AI_VIDEO_EDITOR_TEST_CAPTURE === "1";
  }

  private platform(): CapturePlatform | null {
    if (this.testCapture()) return "test";
    if (this.options.platform === "linux" || this.options.platform === "win32")
      return this.options.platform;
    return null;
  }

  private unavailable(): string | null {
    const platform = this.platform();
    if (!platform) return recordingIssues.unavailable;
    if (
      platform === "linux" &&
      (this.options.env.XDG_SESSION_TYPE === "wayland" ||
        !this.options.env.DISPLAY)
    )
      return recordingIssues.wayland;
    return null;
  }

  private async listMicrophones(): Promise<AudioInput[]> {
    const list = this.options.listOutput ?? output;
    if (this.testCapture()) return [testToneInput];
    if (this.options.platform === "linux")
      return parsePulseSources(
        await list("pactl", ["list", "short", "sources"]),
      );
    if (this.options.platform === "win32")
      return parseDshowAudio(
        await list(this.ffmpeg, [
          "-hide_banner",
          "-list_devices",
          "true",
          "-f",
          "dshow",
          "-i",
          "dummy",
        ]),
      );
    return [];
  }

  async devices(): Promise<RecordingDevices> {
    const message = this.unavailable();
    this.displays.clear();
    this.microphones.clear();
    if (!message) {
      const displays: PhysicalDisplay[] = this.testCapture()
        ? [
            {
              id: "test-pattern",
              label: "Test pattern (not a screen)",
              x: 0,
              y: 0,
              width: 320,
              height: 180,
              primary: true,
            },
          ]
        : this.options.displays();
      for (const display of displays.slice(0, 16))
        this.displays.set(display.id, display);
      for (const microphone of (await this.listMicrophones()).slice(0, 64))
        this.microphones.set(microphone.id, microphone);
    }
    const value: RecordingDevices = {
      displays: [...this.displays.values()].map((display, index) => {
        const size = captureSize(display);
        return {
          id: display.id,
          label: display.label || `Display ${index + 1}`,
          width: size.width,
          height: size.height,
          primary: (display as PhysicalDisplay).primary === true,
        };
      }),
      microphones: [...this.microphones.values()].map((microphone) => ({
        id: microphone.id,
        label: microphone.label,
      })),
      message,
    };
    assertRecordingDevices(value);
    return value;
  }

  busy(): boolean {
    return (
      this.session !== null &&
      ["starting", "recording", "paused", "finishing"].includes(
        this.view.status,
      )
    );
  }

  get(): RecordingView {
    const session = this.session;
    if (session && ["recording", "paused"].includes(this.view.status)) {
      const state = session.state();
      const interrupted =
        this.wantRecording && state.status === "paused" && state.interrupted;
      if (interrupted) this.wantRecording = false;
      this.view = {
        status: state.status === "recording" ? "recording" : "paused",
        elapsedUs: state.elapsedUs,
        missedFrames: state.dropped + state.duplicated,
        media: null,
        message: interrupted ? recordingIssues.interrupted : this.view.message,
      };
    }
    assertRecordingView(this.view);
    return this.view;
  }

  /** The area of a display the user drags out, in its physical pixels. */
  async pickRegion(displayId: string): Promise<RecordingRegion | null> {
    if (this.busy()) throw new RecordingError(recordingIssues.busy);
    const display = this.displays.get(displayId);
    if (!display) throw new RecordingError(recordingIssues.device);
    if (!this.options.pickArea || this.platform() === "darwin")
      throw new RecordingError(recordingIssues.regionUnavailable);
    const area = await this.options.pickArea(displayId);
    if (!area) return null;
    const fraction = (value: number) =>
      Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
    const x = Math.round(fraction(area.x) * display.width);
    const y = Math.round(fraction(area.y) * display.height);
    // Even sizes, as capture records them.
    const even = (value: number) => Math.floor(value / 2) * 2;
    const region = {
      x,
      y,
      width: even(
        Math.min(
          display.width - x,
          Math.round(fraction(area.width) * display.width),
        ),
      ),
      height: even(
        Math.min(
          display.height - y,
          Math.round(fraction(area.height) * display.height),
        ),
      ),
    };
    if (region.width < minimumRegionSize || region.height < minimumRegionSize)
      throw new RecordingError(recordingIssues.region);
    assertRecordingRegion(region);
    return region;
  }

  async start(request: RecordingStartRequest): Promise<RecordingView> {
    if (this.busy()) throw new RecordingError(recordingIssues.busy);
    const message = this.unavailable();
    if (message) throw new RecordingError(message);
    const whole = this.displays.get(request.display_id);
    const region = request.region;
    if (
      whole &&
      region &&
      (this.platform() === "darwin" ||
        region.x + region.width > whole.width ||
        region.y + region.height > whole.height)
    )
      throw new RecordingError(recordingIssues.device);
    // A region is a smaller display target inside the chosen display.
    const display =
      whole && region
        ? {
            ...whole,
            x: whole.x + region.x,
            y: whole.y + region.y,
            width: region.width,
            height: region.height,
          }
        : whole;
    const microphone =
      request.microphone_id === null
        ? null
        : this.microphones.get(request.microphone_id);
    const platform = this.platform()!;
    if (!display || microphone === undefined)
      throw new RecordingError(recordingIssues.device);
    await this.discard();
    const directory = join(this.options.root, randomUUID());
    await mkdir(directory, { recursive: true, mode: 0o700 });
    this.directory = directory;
    const session = new CaptureSession({
      ffmpeg: this.ffmpeg,
      ffprobe: this.ffprobe,
      directory,
      request: {
        platform,
        ...(platform === "linux" && this.options.env.DISPLAY
          ? { x11Display: this.options.env.DISPLAY }
          : {}),
        display,
        microphone,
        frameRate: 30,
      },
    });
    this.session = session;
    this.view = { ...idle, status: "starting" };
    try {
      await session.record();
    } catch {
      await this.discard();
      this.view = { ...idle, status: "failed", message: recordingIssues.start };
      throw new RecordingError(recordingIssues.start);
    }
    this.wantRecording = true;
    this.view = { ...idle, status: "recording" };
    return this.get();
  }

  async pause(): Promise<RecordingView> {
    if (this.session && this.view.status === "recording") {
      this.wantRecording = false;
      await this.session.pause();
      this.view = { ...this.get(), status: "paused" };
    }
    return this.get();
  }

  async resume(): Promise<RecordingView> {
    if (this.session && this.view.status === "paused") {
      try {
        await this.session.record();
      } catch {
        this.view = { ...this.get(), message: recordingIssues.start };
        throw new RecordingError(recordingIssues.start);
      }
      this.wantRecording = true;
      this.view = { ...this.get(), status: "recording", message: null };
    }
    return this.get();
  }

  async stop(): Promise<RecordingView> {
    const session = this.session;
    if (!session || !["recording", "paused"].includes(this.view.status))
      return this.get();
    this.wantRecording = false;
    const last = this.get();
    this.view = { ...last, status: "finishing" };
    let media: MediaSummary;
    try {
      if (session.state().frames === 0 && last.status === "paused") {
        await session.cancel();
        throw new RecordingError(recordingIssues.empty);
      }
      const finished = await session.stop();
      // The file name becomes the source and project name.
      const named = join(this.directory!, `${takeName(new Date())}.mkv`);
      await rename(finished.path, named);
      media = await this.options.importFile(named);
    } catch (error) {
      // The take folder is kept only while the session can still use it.
      await this.discard();
      this.view = {
        ...idle,
        status: "failed",
        message:
          error instanceof RecordingError
            ? error.message
            : recordingIssues.finish,
      };
      return this.get();
    }
    // The library holds its own verified copy. The working media is removed;
    // session.json stays as the take's sync and dropped-frame evidence.
    const directory = this.directory!;
    this.directory = null;
    await this.discard();
    for (const name of await readdir(directory).catch(() => []))
      if (name !== "session.json")
        await rm(join(directory, name), { force: true }).catch(() => undefined);
    this.view = {
      status: "finished",
      elapsedUs: media.durationUs,
      missedFrames: last.missedFrames,
      media,
      message: null,
    };
    return this.get();
  }

  /** Discards an unfinished take, or clears a finished or failed result. */
  async cancel(): Promise<RecordingView> {
    if (this.session && this.busy()) await this.session.cancel();
    await this.discard();
    this.view = idle;
    return this.get();
  }

  private async discard(): Promise<void> {
    this.session = null;
    this.wantRecording = false;
    const directory = this.directory;
    this.directory = null;
    if (directory)
      await rm(directory, { recursive: true, force: true }).catch(
        () => undefined,
      );
  }
}
