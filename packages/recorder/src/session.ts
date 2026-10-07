import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { open, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
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
}

export interface SessionOptions {
  ffmpeg: string;
  ffprobe: string;
  directory: string;
  request: Omit<SegmentRequest, "outputPath">;
  onUpdate?: () => void;
}

interface Running {
  child: ChildProcess;
  record: SegmentRecord;
  stderr: string;
  stopping: boolean;
  done: Promise<void>;
  counters: CaptureCounters;
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

export class CaptureSession {
  readonly id = randomUUID();
  private readonly options: SessionOptions;
  private readonly segments: SegmentRecord[] = [];
  private current: Running | null = null;
  private status: SessionStatus = "paused";
  private readonly pauses: { afterFrames: number }[] = [];
  private readonly frameRate: number;

  constructor(options: SessionOptions) {
    this.options = options;
    this.frameRate = options.request.frameRate;
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

  /** Starts (or resumes with) a new capture segment. */
  async record(): Promise<void> {
    if (this.current || !["paused"].includes(this.status))
      throw new Error("Recording is already running.");
    const file = join(
      this.options.directory,
      `segment-${String(this.segments.length + 1).padStart(3, "0")}.mkv`,
    );
    const args = segmentArguments({
      ...this.options.request,
      outputPath: file,
    });
    const child = spawn(this.options.ffmpeg, args, {
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const running: Running = {
      child,
      stderr: "",
      stopping: false,
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
    // The capture must actually produce frames before the take counts as started.
    const deadline = Date.now() + 10_000;
    while (running.counters.frames === 0 && this.current === running) {
      if (Date.now() > deadline) {
        await this.end();
        this.status = "failed";
        throw new Error("The screen could not be captured.");
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (this.current !== running) {
      this.status = "failed";
      throw new Error("The screen could not be captured.");
    }
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
    this.segments.push(running.record);
    if (this.current === running) {
      this.current = null;
      if (this.status === "recording") this.status = "paused";
    }
    this.options.onUpdate?.();
  }

  /** Ends the running segment gracefully ("q"), killing it if it hangs. */
  private async end(): Promise<void> {
    const running = this.current;
    if (!running) return;
    running.stopping = true;
    running.child.stdin?.end("q\n");
    const timer = setTimeout(() => running.child.kill("SIGKILL"), 15_000);
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

  /** Stops, aligns and joins the take; returns the finished lossless file. */
  async stop(): Promise<FinishedRecording> {
    await this.end();
    this.status = "finishing";
    this.options.onUpdate?.();
    try {
      const usable: SegmentRecord[] = [];
      const aligned: string[] = [];
      const fd = 1;
      const fn = this.frameRate;
      for (const [index, segment] of this.segments.entries()) {
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
        const frames = Number(counted.trim());
        if (!Number.isSafeInteger(frames) || frames <= 0) continue;
        segment.frames = frames;
        const target = join(this.options.directory, `aligned-${index + 1}.mkv`);
        const samples = (frames * captureSampleRate * fd) / fn;
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
        if (
          this.options.request.microphone &&
          segment.audioStartSeconds !== null
        ) {
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
        usable.push(segment);
        aligned.push(target);
      }
      if (aligned.length === 0) throw new Error("Nothing was recorded.");
      const finalPath = join(this.options.directory, "recording.mkv");
      if (aligned.length === 1) await rename(aligned[0]!, finalPath);
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
      const frames = usable.reduce((sum, segment) => sum + segment.frames, 0);
      const hash = createHash("sha256");
      const handle = await open(finalPath, "r");
      try {
        for await (const chunk of handle.createReadStream())
          hash.update(chunk as Buffer);
      } finally {
        await handle.close();
      }
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
            output_sha256: hash.digest("hex"),
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
      };
    } catch (error) {
      this.status = "failed";
      this.options.onUpdate?.();
      throw error;
    }
  }
}
