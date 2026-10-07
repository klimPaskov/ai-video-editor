import { access, mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  createPlaybackProxy,
  needsPlaybackProxy,
  proxyEncoder,
  proxyMime,
  type ProxyEncoder,
} from "../../../packages/media-engine/src/proxy.ts";
import {
  playbackIssues,
  type PlaybackView,
} from "../../../packages/domain/src/playback-view.ts";

export interface PlaybackSource {
  sha256: string;
  path: string;
  probe: unknown;
}

interface Job {
  status: "preparing" | "ready" | "failed";
  progress: number;
}

function durationUs(probe: unknown): number {
  const seconds = Number(
    (probe as { format?: { duration?: unknown } })?.format?.duration,
  );
  return Number.isFinite(seconds) && seconds > 0
    ? Math.round(seconds * 1_000_000)
    : 0;
}

function hasAudio(probe: unknown): boolean {
  const streams = (probe as { streams?: { codec_type?: unknown }[] })?.streams;
  return (
    Array.isArray(streams) &&
    streams.some((stream) => stream?.codec_type === "audio")
  );
}

/**
 * Main-owned playback copies, keyed by source hash so every project sharing
 * a source reuses one. Copies are made one at a time in the background and
 * appear on the media route only once complete.
 */
export class DesktopPlaybackProxies {
  private readonly root: string;
  private readonly ffmpeg: string;
  private encoder: Promise<ProxyEncoder> | null = null;
  private readonly jobs = new Map<string, Job>();
  private queue: Promise<unknown> = Promise.resolve();
  private readonly controller = new AbortController();

  constructor(options: { root: string; ffmpeg?: string }) {
    this.root = options.root;
    this.ffmpeg = options.ffmpeg ?? "ffmpeg";
  }

  private chosenEncoder(): Promise<ProxyEncoder> {
    this.encoder ??= proxyEncoder(this.ffmpeg);
    this.encoder.catch(() => {
      this.encoder = null;
    });
    return this.encoder;
  }

  private async existing(sha256: string): Promise<string | null> {
    for (const extension of ["mp4", "webm"]) {
      const path = join(this.root, `${sha256}.${extension}`);
      if (
        await access(path).then(
          () => true,
          () => false,
        )
      )
        return path;
    }
    return null;
  }

  private ensure(source: PlaybackSource): Job {
    let job = this.jobs.get(source.sha256);
    if (job && job.status !== "failed") return job;
    job = { status: "preparing", progress: 0 };
    const current = job;
    this.jobs.set(source.sha256, current);
    this.queue = this.queue.then(async () => {
      if (this.controller.signal.aborted) return;
      try {
        if (await this.existing(source.sha256)) {
          current.status = "ready";
          return;
        }
        const encoder = await this.chosenEncoder();
        await mkdir(this.root, { recursive: true, mode: 0o700 });
        await createPlaybackProxy({
          ffmpeg: this.ffmpeg,
          input: source.path,
          output: join(
            this.root,
            `${source.sha256}.${encoder === "h264" ? "mp4" : "webm"}`,
          ),
          encoder,
          hasAudio: hasAudio(source.probe),
          durationUs: durationUs(source.probe),
          signal: this.controller.signal,
          onProgress: (fraction) => {
            current.progress = fraction;
          },
        });
        current.status = "ready";
      } catch {
        current.status = "failed";
      }
    });
    return current;
  }

  /** Starts any missing copies and reports the project's playback state. */
  async view(sources: PlaybackSource[]): Promise<PlaybackView> {
    const needed = sources.filter((source) => needsPlaybackProxy(source.probe));
    const jobs: Job[] = [];
    for (const source of needed) {
      if (!this.jobs.has(source.sha256) && (await this.existing(source.sha256)))
        this.jobs.set(source.sha256, { status: "ready", progress: 1 });
      jobs.push(this.ensure(source));
    }
    if (jobs.some((job) => job.status === "failed"))
      return {
        status: "failed",
        progress: null,
        message: playbackIssues.failed,
      };
    if (jobs.some((job) => job.status === "preparing"))
      return {
        status: "preparing",
        progress:
          jobs.reduce(
            (sum, job) => sum + (job.status === "ready" ? 1 : job.progress),
            0,
          ) / jobs.length,
        message: null,
      };
    return { status: "ready", progress: null, message: null };
  }

  /** The file the media route serves for a source, or null if not ready. */
  async resolve(
    source: PlaybackSource,
    mime: string,
  ): Promise<{ path: string; mime: string } | null> {
    if (!needsPlaybackProxy(source.probe)) return { path: source.path, mime };
    const path = await this.existing(source.sha256);
    if (!path) return null;
    return {
      path,
      mime: proxyMime(path.endsWith(".mp4") ? "h264" : "vp9"),
    };
  }

  close(): void {
    this.controller.abort();
  }
}
