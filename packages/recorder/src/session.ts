import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { killProcessTree } from "./process-tree.ts";
import {
  audioAlignmentFilter,
  captureSampleRate,
  parseInputStarts,
  parseProgress,
  segmentArguments,
  type CaptureCounters,
  type SegmentRequest,
} from "./capture.ts";

/**
 * One recording take. Each Record/Resume runs one capture segment; Pause and
 * Stop end it gracefully. Stop aligns every segment's microphone to its first
 * video frame with exact samples, joins segments without re-encoding, and
 * writes a session record with offsets, pauses and frame counters.
 */
export type SessionStatus =
  "recording" | "paused" | "finishing" | "finished" | "failed" | "cancelled";

export interface SegmentRecord {
  file: string;
  frames: number;
  duplicated: number;
  dropped: number;
  videoStartSeconds: number | null;
  audioStartSeconds: number | null;
  audioOffsetSamples: number;
  /** Ended without Pause/Stop (device loss or encoder failure). */
  interrupted: boolean;
}

export interface SessionState {
  status: SessionStatus;
  elapsedUs: number;
  frames: number;
  duplicated: number;
  dropped: number;
  interrupted: boolean;
}

export interface FinishedRecording {
  path: string;
  frames: number;
  durationUs: number;
  record: string;
  /** SHA-256 of `path`, computed once so the library need not read it again. */
  sha256: string;
}

/** Why a capture did not start; main maps it to a plain, actionable message. */
export type CaptureStartFailure = "microphone" | "screen" | "timeout";

export class CaptureStartError extends Error {
  readonly failure: CaptureStartFailure;
  constructor(failure: CaptureStartFailure) {
    super("The capture could not be started.");
    this.failure = failure;
  }
}

export interface SessionOptions {
  ffmpeg: string;
  ffprobe: string;
  directory: string;
  request: Omit<SegmentRequest, "outputPath">;
  onUpdate?: () => void;
  /**
   * Runs each capture through `capture-supervisor` so FFmpeg stops when the
   * app goes away. `executable` runs `script` as Node.
   */
  supervisor?: {
    executable: string;
    script: string;
    env?: NodeJS.ProcessEnv;
  };
}

interface Running {
  child: ChildProcess;
  record: SegmentRecord;
  stderr: string;
  stopping: boolean;
  done: Promise<void>;
  counters: CaptureCounters;
  /** FFmpeg's final "progress=end" arrived, so `counters.frames` is exact. */
  ended: boolean;
  /** Called once when the first frame has been captured. */
  onFrame?: () => void;
}

const lockedCodes = new Set(["EBUSY", "EPERM", "EACCES"]);

/**
 * Renames a file, waiting out the short lock Windows (antivirus, search
 * indexing) keeps on a file that was just written.
 */
export async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 8 || !code || !lockedCodes.has(code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 75 * (attempt + 1)));
    }
  }
}

/** SHA-256 of a file, read in large blocks (the 64 KiB default is slow). */
export async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path, {
    highWaterMark: 8 * 1024 * 1024,
  }))
    hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** Runs `tasks` with at most `limit` at once, keeping result order. */
async function pooled<T>(
  tasks: (() => Promise<T>)[],
  limit: number,
): Promise<T[]> {
  const results: T[] = new Array<T>(tasks.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, tasks.length) }, async () => {
      while (next < tasks.length) {
        const index = next++;
        results[index] = await tasks[index]!();
      }
    }),
  );
  return results;
}

/** Which input an early FFmpeg exit blames, from its own error text. */
function startFailure(
  stderr: string,
  hasMicrophone: boolean,
): CaptureStartFailure {
  return hasMicrophone &&
    /dshow|audio=|pulse|alsa|avfoundation|Could not run graph|Error opening input/iu.test(
      stderr,
    ) &&
    !/gdigrab|x11grab|screen capture/iu.test(stderr)
    ? "microphone"
    : "screen";
}

/**
 * The capture's colour description, restated on every remux so the take
 * stays self-describing even if a stream copy does not carry the tags.
 */
const captureColor = [
  "-color_range",
  "pc",
  "-colorspace",
  "rgb",
  "-color_primaries",
  "bt709",
  "-color_trc",
  "iec61966-2-1",
];

function run(executable: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.resume();
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0
        ? resolve(Buffer.concat(out).toString())
        : reject(new Error("Recording could not be finished.")),
    );
  });
}

/**
 * Progress record kept beside the segments while a take is running, so a
 * take cut short by a crash can still be aligned and joined later.
 */
export interface TakeRecord {
  schema_version: "1.0";
  session_id: string;
  created_at: string;
  platform: SegmentRequest["platform"];
  display: string;
  microphone: string | null;
  frame_rate: 30 | 60;
  segments: SegmentRecord[];
  pauses: { afterFrames: number }[];
}

export const takeRecordName = "take.json";

export class CaptureSession {
  readonly id: string = randomUUID();
  private readonly options: SessionOptions;
  private readonly segments: SegmentRecord[] = [];
  private current: Running | null = null;
  private status: SessionStatus = "paused";
  private readonly pauses: { afterFrames: number }[] = [];
  private readonly frameRate: number;
  private readonly createdAt = new Date().toISOString();
  private saving: Promise<void> = Promise.resolve();
  /** Frame counts FFmpeg reported at a clean stop; no re-count needed. */
  private readonly exactFrames = new Map<string, number>();

  constructor(options: SessionOptions) {
    this.options = options;
    this.frameRate = options.request.frameRate;
  }

  /**
   * A session for a take left behind by a crash, ready for `stop()`: its
   * segments come from the take record; one still open is interrupted.
   */
  static async recover(options: {
    ffmpeg: string;
    ffprobe: string;
    directory: string;
  }): Promise<CaptureSession> {
    const record = JSON.parse(
      await readFile(join(options.directory, takeRecordName), "utf8"),
    ) as TakeRecord;
    if (
      record?.schema_version !== "1.0" ||
      !Array.isArray(record.segments) ||
      !Array.isArray(record.pauses) ||
      (record.frame_rate !== 30 && record.frame_rate !== 60)
    )
      throw new Error("This recording cannot be recovered.");
    const session = new CaptureSession({
      ...options,
      request: {
        platform: record.platform,
        display: {
          id: "recovered",
          label: String(record.display),
          x: 0,
          y: 0,
          width: 2,
          height: 2,
        },
        // Only whether there was a microphone matters when finishing.
        microphone:
          record.microphone === null
            ? null
            : {
                id: "recovered",
                label: String(record.microphone),
                format: "test_tone",
                device: "",
              },
        frameRate: record.frame_rate,
      },
    });
    for (const segment of record.segments) {
      // Segment files are always the session's own numbered files.
      const file = join(
        options.directory,
        String(segment.file).split(/[\\/]/u).pop() ?? "",
      );
      if (!/^segment-\d{3}\.mkv$/u.test(file.split(/[\\/]/u).pop()!)) continue;
      session.segments.push({ ...segment, file });
    }
    session.pauses.push(...record.pauses);
    return session;
  }

  /** Persists the take record; writes are serialised and best effort. */
  private saveTake(): void {
    const running = this.current;
    const segments = [...this.segments];
    if (running) {
      const starts = parseInputStarts(running.stderr);
      segments.push({
        ...running.record,
        frames: running.counters.frames,
        videoStartSeconds: starts[0] ?? null,
        audioStartSeconds: this.options.request.microphone
          ? (starts[1] ?? null)
          : null,
        interrupted: true,
      });
    }
    const record: TakeRecord = {
      schema_version: "1.0",
      session_id: this.id,
      created_at: this.createdAt,
      platform: this.options.request.platform,
      display: this.options.request.display.label,
      microphone: this.options.request.microphone?.label ?? null,
      frame_rate: this.options.request.frameRate,
      segments,
      pauses: [...this.pauses],
    };
    const file = join(this.options.directory, takeRecordName);
    this.saving = this.saving
      .then(async () => {
        await writeFile(`${file}.partial`, JSON.stringify(record, null, 2), {
          mode: 0o600,
        });
        await rename(`${file}.partial`, file);
      })
      .catch(() => undefined);
  }

  state(): SessionState {
    const counters = this.segments.reduce(
      (sum, segment) => ({
        frames: sum.frames + segment.frames,
        duplicated: sum.duplicated + segment.duplicated,
        dropped: sum.dropped + segment.dropped,
      }),
      { frames: 0, duplicated: 0, dropped: 0 },
    );
    if (this.current) {
      counters.frames += this.current.counters.frames;
      counters.duplicated += this.current.counters.duplicated;
      counters.dropped += this.current.counters.dropped;
    }
    return {
      status: this.status,
      elapsedUs: Math.round((counters.frames * 1_000_000) / this.frameRate),
      ...counters,
      interrupted: this.segments.some((segment) => segment.interrupted),
    };
  }

  /**
   * Starts (or resumes with) a new capture segment. A device that is briefly
   * busy makes FFmpeg exit at once; that is retried one time.
   */
  async record(): Promise<void> {
    if (this.current || !["paused"].includes(this.status))
      throw new Error("Recording is already running.");
    try {
      await this.launch();
    } catch (error) {
      if (!(error instanceof CaptureStartError) || error.failure === "timeout")
        throw error;
      await new Promise((resolve) => setTimeout(resolve, 400));
      this.status = "paused";
      await this.launch();
    }
  }

  private async launch(): Promise<void> {
    const file = join(
      this.options.directory,
      `segment-${String(this.segments.length + 1).padStart(3, "0")}.mkv`,
    );
    const args = segmentArguments({
      ...this.options.request,
      outputPath: file,
    });
    const supervisor = this.options.supervisor;
    const child = supervisor
      ? spawn(
          supervisor.executable,
          [supervisor.script, this.options.ffmpeg, ...args],
          {
            shell: false,
            windowsHide: true,
            stdio: ["pipe", "pipe", "pipe"],
            ...(supervisor.env ? { env: supervisor.env } : {}),
          },
        )
      : spawn(this.options.ffmpeg, args, {
          shell: false,
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
        });
    const running: Running = {
      child,
      stderr: "",
      stopping: false,
      ended: false,
      counters: { frames: 0, duplicated: 0, dropped: 0 },
      record: {
        file,
        frames: 0,
        duplicated: 0,
        dropped: 0,
        videoStartSeconds: null,
        audioStartSeconds: null,
        audioOffsetSamples: 0,
        interrupted: false,
      },
      done: Promise.resolve(),
    };
    child.stdin.on("error", () => undefined);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      running.counters = parseProgress(chunk, running.counters);
      if (chunk.includes("progress=end")) running.ended = true;
      if (running.counters.frames > 0) running.onFrame?.();
      this.options.onUpdate?.();
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (running.stderr.length < 256 * 1024) running.stderr += chunk;
    });
    running.done = new Promise<void>((resolve) => {
      child.once("error", () => resolve());
      child.once("close", () => resolve());
    }).then(() => this.closed(running));
    this.current = running;
    this.status = "recording";
    // The capture must actually produce frames before the take counts as
    // started. The wait ends on the first frame, not on a polling tick.
    const outcome = await new Promise<"frame" | "closed" | "timeout">(
      (resolve) => {
        const timer = setTimeout(() => resolve("timeout"), 10_000);
        running.onFrame = () => {
          clearTimeout(timer);
          resolve("frame");
        };
        void running.done.then(() => {
          clearTimeout(timer);
          resolve("closed");
        });
      },
    );
    if (outcome !== "frame" || this.current !== running) {
      if (outcome === "timeout") await this.end();
      else await running.done;
      // A segment that never captured a frame is not part of the take.
      const index = this.segments.indexOf(running.record);
      if (index >= 0) this.segments.splice(index, 1);
      await rm(file, { force: true }).catch(() => undefined);
      this.status = outcome === "timeout" ? "failed" : "paused";
      throw new CaptureStartError(
        outcome === "timeout"
          ? "timeout"
          : startFailure(running.stderr, !!this.options.request.microphone),
      );
    }
    this.saveTake();
    this.options.onUpdate?.();
  }

  private closed(running: Running): void {
    const starts = parseInputStarts(running.stderr);
    running.record.frames = running.counters.frames;
    running.record.duplicated = running.counters.duplicated;
    running.record.dropped = running.counters.dropped;
    running.record.videoStartSeconds = starts[0] ?? null;
    running.record.audioStartSeconds = this.options.request.microphone
      ? (starts[1] ?? null)
      : null;
    running.record.interrupted = !running.stopping;
    if (running.stopping && running.ended && running.counters.frames > 0)
      this.exactFrames.set(running.record.file, running.counters.frames);
    this.segments.push(running.record);
    if (this.current === running) {
      this.current = null;
      if (this.status === "recording") this.status = "paused";
    }
    this.saveTake();
    this.options.onUpdate?.();
  }

  /** Ends the running segment gracefully ("q"), killing it if it hangs. */
  private async end(): Promise<void> {
    const running = this.current;
    if (!running) return;
    running.stopping = true;
    running.child.stdin?.end("q\n");
    const timer = setTimeout(() => killProcessTree(running.child), 15_000);
    await running.done;
    clearTimeout(timer);
  }

  async pause(): Promise<void> {
    if (this.status !== "recording") return;
    await this.end();
    this.pauses.push({ afterFrames: this.state().frames });
    this.status = "paused";
  }

  async cancel(): Promise<void> {
    await this.end();
    this.status = "cancelled";
  }

  /** Whether a segment is tagged exactly as the stream-copy remux would tag it. */
  private async hasCaptureColor(
    file: string,
    probe: (executable: string, args: string[]) => Promise<string>,
  ): Promise<boolean> {
    const tags = await probe(this.options.ffprobe, [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=color_range,color_space,color_primaries,color_transfer",
      "-of",
      "default=nw=1",
      file,
    ]).catch(() => "");
    return (
      tags.includes("color_range=pc") &&
      tags.includes("color_space=gbr") &&
      tags.includes("color_primaries=bt709") &&
      tags.includes("color_transfer=iec61966-2-1")
    );
  }

  /** Stops, aligns and joins the take; returns the finished lossless file. */
  async stop(): Promise<FinishedRecording> {
    await this.end();
    await this.saving;
    this.status = "finishing";
    this.options.onUpdate?.();
    try {
      const fn = this.frameRate;
      const microphone = this.options.request.microphone;
      // Frame counts: a clean stop already reported its exact count, so the
      // file need not be read again; anything else is counted by FFmpeg.
      const counts = await Promise.all(
        this.segments.map(async (segment) => {
          const known = this.exactFrames.get(segment.file);
          if (known !== undefined) return known;
          const counted = await run(this.options.ffprobe, [
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-count_packets",
            "-show_entries",
            "stream=nb_read_packets",
            "-of",
            "csv=p=0",
            segment.file,
          ]).catch(() => "0");
          return Number(counted.trim());
        }),
      );
      const usable: SegmentRecord[] = [];
      const counted: number[] = [];
      for (const [index, segment] of this.segments.entries()) {
        const frames = counts[index]!;
        if (!Number.isSafeInteger(frames) || frames <= 0) continue;
        segment.frames = frames;
        usable.push(segment);
        counted.push(index);
      }
      if (usable.length === 0) throw new Error("Nothing was recorded.");
      const finalPath = join(this.options.directory, "recording.mkv");
      if (
        usable.length === 1 &&
        !microphone &&
        (await this.hasCaptureColor(usable[0]!.file, run))
      ) {
        // One video-only segment that already carries the capture's colour
        // tags is the finished lossless file: it is renamed, not rewritten.
        await renameWithRetry(usable[0]!.file, finalPath);
      } else {
        // Segments are independent, so they are aligned a few at a time.
        const aligned = await pooled(
          usable.map((segment, position) => async () => {
            const target = join(
              this.options.directory,
              `aligned-${counted[position]! + 1}.mkv`,
            );
            const samples = (segment.frames * captureSampleRate) / fn;
            const args = [
              "-hide_banner",
              "-nostdin",
              "-loglevel",
              "error",
              "-i",
              segment.file,
              "-map",
              "0:v:0",
              "-c:v",
              "copy",
            ];
            if (microphone && segment.audioStartSeconds !== null) {
              const filter = audioAlignmentFilter({
                videoStartSeconds: segment.videoStartSeconds ?? 0,
                audioStartSeconds: segment.audioStartSeconds,
              });
              segment.audioOffsetSamples = Math.round(
                ((segment.audioStartSeconds ?? 0) -
                  (segment.videoStartSeconds ?? 0)) *
                  captureSampleRate,
              );
              args.push(
                "-map",
                "0:a:0",
                "-af",
                // Exactly one video duration of audio per segment keeps joins exact.
                `${filter},atrim=end_sample=${samples},apad=whole_len=${samples}`,
                "-c:a",
                "pcm_s16le",
              );
            }
            args.push(
              ...captureColor,
              "-fflags",
              "+bitexact",
              "-f",
              "matroska",
              target,
            );
            await run(this.options.ffmpeg, args);
            return target;
          }),
          3,
        );
        if (aligned.length === 1) await renameWithRetry(aligned[0]!, finalPath);
        else {
          const list = join(this.options.directory, "segments.txt");
          await writeFile(
            list,
            aligned
              .map((file) => `file '${file.replaceAll("'", "'\\''")}'`)
              .join("\n") + "\n",
          );
          await run(this.options.ffmpeg, [
            "-hide_banner",
            "-nostdin",
            "-loglevel",
            "error",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            list,
            "-c",
            "copy",
            ...captureColor,
            "-fflags",
            "+bitexact",
            "-f",
            "matroska",
            finalPath,
          ]);
        }
      }
      const frames = usable.reduce((sum, segment) => sum + segment.frames, 0);
      const sha256 = await hashFile(finalPath);
      const record = join(this.options.directory, "session.json");
      await writeFile(
        record,
        JSON.stringify(
          {
            schema_version: "1.0",
            session_id: this.id,
            created_at: new Date().toISOString(),
            platform: this.options.request.platform,
            display: this.options.request.display.label,
            microphone: this.options.request.microphone?.label ?? null,
            frame_rate: this.frameRate,
            sample_rate: captureSampleRate,
            segments: usable,
            pauses: this.pauses,
            frames,
            output_sha256: sha256,
          },
          null,
          2,
        ),
        { mode: 0o600 },
      );
      this.status = "finished";
      this.options.onUpdate?.();
      return {
        path: finalPath,
        frames,
        durationUs: Math.round((frames * 1_000_000) / fn),
        record,
        sha256,
      };
    } catch (error) {
      this.status = "failed";
      this.options.onUpdate?.();
      throw error;
    }
  }
}
