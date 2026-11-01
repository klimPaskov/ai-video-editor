import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  captureSize,
  parseDshowAudio,
  parseDshowVideo,
  parsePulseSources,
  testPatternCamera,
  testToneInput,
  type AudioInput,
  type CapturePlatform,
  type DisplayTarget,
  type VideoInput,
} from "../../../packages/recorder/src/capture.ts";
import {
  CaptureSession,
  CaptureStartError,
  renameWithRetry,
  takeRecordName,
} from "../../../packages/recorder/src/session.ts";
import type { MediaSummary } from "../../../packages/domain/src/library.ts";
import {
  assertInterruptedTakes,
  assertRecordingDevices,
  assertRecordingRegion,
  assertRecordingView,
  minimumRegionSize,
  recordingIssues,
  type InterruptedTake,
  type InterruptedTakes,
  type RecordingDevices,
  type RecordingRegion,
  type RecordingStartRequest,
  type RecordingView,
} from "../../../packages/domain/src/recording-view.ts";

export class RecordingError extends Error {}

interface InputListing {
  microphones: AudioInput[];
  cameras: VideoInput[];
  reliable: boolean;
}

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
  /**
   * `adopt` carries the SHA-256 the recorder already computed for its own
   * finished take, so the library can move it in without reading it again.
   */
  importFile(path: string, adopt?: { sha256: string }): Promise<MediaSummary>;
  /**
   * A take with a camera: the camera recording's library entry goes with
   * the screen recording's. Called once both are imported.
   */
  onCamera?(screenMediaId: string, cameraMediaId: string): Promise<void>;
  /** Runs captures under the capture supervisor (see the session). */
  supervisor?: {
    executable: string;
    script: string;
    env?: NodeJS.ProcessEnv;
  };
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
  /** Last good device listing; each probe starts a process (~0.8 s). */
  private inputCache: { at: number; found: InputListing } | null = null;
  private inputProbe: Promise<InputListing> | null = null;
  private cameras = new Map<string, VideoInput>();
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

  /** Linux cameras from /dev; the first node of each name is the picture. */
  private async v4l2Cameras(): Promise<VideoInput[]> {
    const found: VideoInput[] = [];
    for (const name of (await readdir("/dev").catch(() => [])).sort()) {
      if (!/^video\d{1,2}$/u.test(name)) continue;
      const label = (
        await readFile(`/sys/class/video4linux/${name}/name`, "utf8").catch(
          () => "",
        )
      )
        .trim()
        .slice(0, 100);
      found.push({
        id: `v4l2-${found.length + 1}`,
        label: label || `Camera ${found.length + 1}`,
        format: "v4l2",
        device: `/dev/${name}`,
      });
    }
    const seen = new Set<string>();
    return found.filter((item) =>
      seen.has(item.label) ? false : (seen.add(item.label), true),
    );
  }

  /**
   * One listing of microphones and cameras; `reliable` is false when the
   * probe printed nothing at all. On Windows one `ffmpeg -list_devices` run
   * answers both.
   */
  private async listInputs(): Promise<InputListing> {
    const list = this.options.listOutput ?? output;
    if (this.testCapture())
      return {
        microphones: [testToneInput],
        cameras: [testPatternCamera],
        reliable: true,
      };
    if (this.options.platform === "linux") {
      const text = await list("pactl", ["list", "short", "sources"]);
      return {
        microphones: parsePulseSources(text),
        cameras: await this.v4l2Cameras(),
        reliable: text.trim() !== "",
      };
    }
    if (this.options.platform === "win32") {
      const text = await list(this.ffmpeg, [
        "-hide_banner",
        "-list_devices",
        "true",
        "-f",
        "dshow",
        "-i",
        "dummy",
      ]);
      return {
        microphones: parseDshowAudio(text),
        cameras: parseDshowVideo(text),
        reliable: text.trim() !== "",
      };
    }
    return { microphones: [], cameras: [], reliable: true };
  }

  /**
   * Microphones and cameras for the setup dialog. Probing starts FFmpeg, so a
   * listing is reused: a recent one is returned at once, an older one is
   * returned at once while a fresh one is read in the background for the
   * next open. Only the very first call (or after a failed probe) waits.
   */
  private async inputList(): Promise<InputListing> {
    const cached = this.inputCache;
    if (cached) {
      if (Date.now() - cached.at > 20_000)
        void this.probeInputs().catch(() => undefined);
      return cached.found;
    }
    return this.probeInputs();
  }

  /** One probe at a time; a blank answer is retried once, never cached. */
  private probeInputs(): Promise<InputListing> {
    this.inputProbe ??= (async () => {
      try {
        let found = await this.listInputs();
        if (!found.reliable) found = await this.listInputs();
        if (found.reliable) this.inputCache = { at: Date.now(), found };
        return found;
      } finally {
        this.inputProbe = null;
      }
    })();
    return this.inputProbe;
  }

  /** Reads the device lists ahead of the first time the dialog opens. */
  warm(): void {
    if (this.unavailable() === null && !this.testCapture())
      void this.probeInputs().catch(() => undefined);
  }

  async devices(): Promise<RecordingDevices> {
    const message = this.unavailable();
    this.displays.clear();
    this.microphones.clear();
    this.cameras.clear();
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
      const inputs = await this.inputList();
      for (const microphone of inputs.microphones.slice(0, 64))
        this.microphones.set(microphone.id, microphone);
      for (const camera of inputs.cameras.slice(0, 16))
        this.cameras.set(camera.id, camera);
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
      cameras: [...this.cameras.values()].map((camera) => ({
        id: camera.id,
        label: camera.label,
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
    const camera =
      request.camera_id === undefined || request.camera_id === null
        ? null
        : this.cameras.get(request.camera_id);
    if (!display || microphone === undefined || camera === undefined)
      throw new RecordingError(recordingIssues.device);
    await this.discard();
    const directory = join(this.options.root, randomUUID());
    await mkdir(directory, { recursive: true, mode: 0o700 });
    this.directory = directory;
    const session = new CaptureSession({
      ffmpeg: this.ffmpeg,
      ffprobe: this.ffprobe,
      directory,
      ...(this.options.supervisor
        ? { supervisor: this.options.supervisor }
        : {}),
      request: {
        platform,
        ...(platform === "linux" && this.options.env.DISPLAY
          ? { x11Display: this.options.env.DISPLAY }
          : {}),
        display,
        microphone,
        ...(camera ? { camera } : {}),
        frameRate: 30,
      },
    });
    this.session = session;
    this.view = { ...idle, status: "starting" };
    try {
      await session.record();
    } catch (error) {
      await this.discard();
      const message = this.startMessage(error);
      // A device that vanished or failed may have changed the listing.
      this.inputCache = null;
      this.view = { ...idle, status: "failed", message };
      throw new RecordingError(message);
    }
    this.wantRecording = true;
    this.view = { ...idle, status: "recording" };
    return this.get();
  }

  /** The plain message for a capture that would not start. */
  private startMessage(error: unknown): string {
    return error instanceof CaptureStartError && error.failure === "microphone"
      ? recordingIssues.microphone
      : recordingIssues.start;
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
      } catch (error) {
        const message = this.startMessage(error);
        this.view = { ...this.get(), message };
        throw new RecordingError(message);
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
      await renameWithRetry(finished.path, named);
      const cameraNamed = finished.cameraPath
        ? join(this.directory!, `${takeName(new Date())} camera.mkv`)
        : null;
      if (finished.cameraPath && cameraNamed)
        await renameWithRetry(finished.cameraPath, cameraNamed);
      // The working segments are deleted while the take is imported (never
      // the two named recordings), and the screen take is moved in (already
      // hashed) rather than copied and re-read.
      const [imported] = await Promise.all([
        this.options.importFile(named, { sha256: finished.sha256 }),
        this.removeWorking(
          this.directory!,
          cameraNamed ? [named, cameraNamed] : [named],
        ),
      ]);
      media = imported;
      // A camera take: its own recording, linked to the screen's.
      if (cameraNamed) {
        const cameraMedia = await this.options.importFile(cameraNamed);
        await this.options.onCamera?.(media.id, cameraMedia.id);
      }
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

  /** Deletes a take's working media (not its record or `keep`). */
  private async removeWorking(
    directory: string,
    keep: string[],
  ): Promise<void> {
    await Promise.all(
      (await readdir(directory).catch(() => [] as string[]))
        .filter(
          (name) =>
            name !== "session.json" && !keep.includes(join(directory, name)),
        )
        .map((name) =>
          rm(join(directory, name), { force: true }).catch(() => undefined),
        ),
    );
  }

  /** Take folders a crash left without a finished recording, newest first. */
  async interrupted(): Promise<InterruptedTakes> {
    const takes: InterruptedTake[] = [];
    for (const name of await readdir(this.options.root).catch(() => [])) {
      const directory = join(this.options.root, name);
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
          name,
        ) ||
        directory === this.directory
      )
        continue;
      const files = await readdir(directory).catch(() => [] as string[]);
      if (
        files.includes("session.json") ||
        !files.includes(takeRecordName) ||
        !files.some((file) => /^segment-\d{3}\.mkv$/u.test(file))
      )
        continue;
      const record = await readFile(join(directory, takeRecordName), "utf8")
        .then((text) => JSON.parse(text) as { created_at?: unknown })
        .catch(() => null);
      const createdAt =
        typeof record?.created_at === "string" &&
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(
          record.created_at,
        )
          ? record.created_at
          : null;
      if (createdAt) takes.push({ id: name, createdAt });
    }
    const value = {
      takes: takes
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 32),
    };
    assertInterruptedTakes(value);
    return value;
  }

  /** Aligns, joins and imports an interrupted take, like Stop would. */
  async recover(takeId: string): Promise<RecordingView> {
    if (this.busy()) throw new RecordingError(recordingIssues.busy);
    const take = (await this.interrupted()).takes.find(
      (item) => item.id === takeId,
    );
    if (!take) throw new RecordingError(recordingIssues.recover);
    const directory = join(this.options.root, take.id);
    let media: MediaSummary;
    try {
      const session = await CaptureSession.recover({
        ffmpeg: this.ffmpeg,
        ffprobe: this.ffprobe,
        directory,
      });
      const finished = await session.stop();
      const named = join(
        directory,
        `${takeName(new Date(take.createdAt))}.mkv`,
      );
      await renameWithRetry(finished.path, named);
      // The segments stay until the import has worked, for another try.
      media = await this.options.importFile(named, {
        sha256: finished.sha256,
      });
    } catch {
      // The segments stay so the user can try again or discard them.
      throw new RecordingError(recordingIssues.recover);
    }
    for (const name of await readdir(directory).catch(() => []))
      if (name !== "session.json")
        await rm(join(directory, name), { force: true }).catch(() => undefined);
    this.view = {
      status: "finished",
      elapsedUs: media.durationUs,
      missedFrames: 0,
      media,
      message: null,
    };
    return this.get();
  }

  /** Deletes an interrupted take's folder. */
  async discardInterrupted(takeId: string): Promise<InterruptedTakes> {
    const take = (await this.interrupted()).takes.find(
      (item) => item.id === takeId,
    );
    if (take)
      await rm(join(this.options.root, take.id), {
        recursive: true,
        force: true,
      });
    return this.interrupted();
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
      await rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      }).catch(() => undefined);
  }
}
