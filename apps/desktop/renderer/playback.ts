import type {
  ProjectClipView,
  ProjectView,
} from "../../../packages/domain/src/project-view.ts";

/**
 * Draft playback for the preview. Two <video> elements play the immutable
 * sources through the app's media route: one shows the current clip while
 * the other waits at the next clip's first frame, so a cut swaps elements
 * instead of seeking. Display only; export renders from the sources itself.
 */
export interface PlaybackHost {
  container: HTMLElement;
  canvas: HTMLCanvasElement;
  project(): ProjectView | undefined;
  /** Current output position in microseconds. */
  position(): number;
  /** Updates position controls while playing, without reading a frame. */
  show(outputUs: number): void;
  /** Playback ended or paused: show the exact still frame. */
  stopped(outputUs: number): void;
  /** Playback state changed (for the Play/Pause control). */
  changed(playing: boolean): void;
  failed(message: string): void;
}

export interface Playback {
  toggle(): void;
  stop(): void;
  playing(): boolean;
}

interface Slot {
  video: HTMLVideoElement;
  clip: number;
  ready: Promise<void> | null;
}

const unplayable =
  "This source cannot be played here. Frame preview and export still work.";

export function setupPlayback(host: PlaybackHost): Playback {
  const make = () => {
    const video = document.createElement("video");
    video.className = "preview-video";
    video.preload = "auto";
    video.playsInline = true;
    video.disablePictureInPicture = true;
    video.controls = false;
    video.hidden = true;
    video.setAttribute("aria-hidden", "true");
    host.container.append(video);
    return video;
  };
  const slots: [Slot, Slot] = [
    { video: make(), clip: -1, ready: null },
    { video: make(), clip: -1, ready: null },
  ];
  let active = 0;
  const slotAt = (index: number): Slot => (index === 0 ? slots[0] : slots[1]);
  let clips: ProjectClipView[] = [];
  let projectId = "";
  let running = false;
  let token = 0;
  let outputUs = 0;
  let frameUs = 33_333;
  let watchdog: ReturnType<typeof setInterval> | undefined;
  let advancing = false;

  const url = (sourceId: string) =>
    new URL(`media/${projectId}/${sourceId}`, location.href).href;

  /** Resolves on `event`, rejects on a media error. */
  function when(video: HTMLVideoElement, event: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const done = () => {
        video.removeEventListener(event, done);
        video.removeEventListener("error", fail);
        resolve();
      };
      const fail = () => {
        video.removeEventListener(event, done);
        video.removeEventListener("error", fail);
        reject(new Error(unplayable));
      };
      video.addEventListener(event, done);
      video.addEventListener("error", fail);
    });
  }

  function load(slot: Slot, index: number, sourceUs: number): Promise<void> {
    const clip = clips[index]!;
    slot.clip = index;
    const video = slot.video;
    const target = url(clip.sourceId);
    slot.ready = (async () => {
      if (video.src !== target) {
        const metadata = when(video, "loadedmetadata");
        video.src = target;
        await metadata;
      } else if (video.readyState < 1) await when(video, "loadedmetadata");
      // Setting the position always runs a seek once metadata is known.
      const seeked = when(video, "seeked");
      video.currentTime = sourceUs / 1_000_000;
      await seeked;
    })();
    // A standby slot that fails is reported only if playback reaches it.
    slot.ready.catch(() => undefined);
    return slot.ready;
  }

  function stopAll(): void {
    for (const slot of slots) {
      slot.video.pause();
      slot.video.hidden = true;
    }
    if (watchdog) clearInterval(watchdog);
    watchdog = undefined;
  }

  function finish(at: number, error?: string): void {
    if (!running) return;
    running = false;
    token++;
    stopAll();
    host.canvas.hidden = false;
    host.changed(false);
    if (error) host.failed(error);
    host.stopped(at);
  }

  function tick(run: number, mediaSeconds: number): void {
    if (run !== token || !running) return;
    const slot = slotAt(active);
    const clip = clips[slot.clip];
    if (!clip) return;
    const sourceUs = Math.round(mediaSeconds * 1_000_000);
    outputUs = Math.min(
      clip.timelineEndUs - 1,
      Math.max(
        clip.timelineStartUs,
        clip.timelineStartUs + sourceUs - clip.sourceStartUs,
      ),
    );
    host.show(outputUs);
    // The frame on screen is the clip's last one: move on after it.
    if (sourceUs + frameUs > clip.sourceEndUs - frameUs / 2) void advance(run);
  }

  function follow(run: number): void {
    const video = slotAt(active).video;
    const step = (_now: number, metadata: { mediaTime: number }) => {
      if (run !== token || !running || slotAt(active).video !== video) return;
      tick(run, metadata.mediaTime);
      video.requestVideoFrameCallback(step);
    };
    video.requestVideoFrameCallback(step);
  }

  async function advance(run: number): Promise<void> {
    if (advancing) return;
    advancing = true;
    try {
      await swap(run);
    } finally {
      advancing = false;
    }
  }

  async function swap(run: number): Promise<void> {
    const current = slotAt(active);
    const nextIndex = current.clip + 1;
    current.video.pause();
    if (nextIndex >= clips.length) {
      finish(clips.at(-1)!.timelineEndUs - Math.ceil(frameUs));
      return;
    }
    const standby = slotAt(1 - active);
    if (standby.clip !== nextIndex || !standby.ready)
      void load(standby, nextIndex, clips[nextIndex]!.sourceStartUs);
    try {
      await standby.ready;
      if (run !== token || !running) return;
      await standby.video.play();
    } catch {
      finish(outputUs, unplayable);
      return;
    }
    if (run !== token || !running) return;
    standby.video.hidden = false;
    current.video.hidden = true;
    active = 1 - active;
    follow(run);
    if (nextIndex + 1 < clips.length)
      void load(current, nextIndex + 1, clips[nextIndex + 1]!.sourceStartUs);
  }

  async function start(): Promise<void> {
    const project = host.project();
    if (!project?.clips?.length) return;
    clips = [...project.clips].sort(
      (a, b) => a.timelineStartUs - b.timelineStartUs,
    );
    projectId = project.id;
    frameUs =
      (1_000_000 * project.timeline.frameRate.denominator) /
      project.timeline.frameRate.numerator;
    let at = host.position();
    if (at >= project.timeline.durationUs - frameUs) at = 0;
    const index = Math.max(
      0,
      clips.findIndex(
        (clip) => at >= clip.timelineStartUs && at < clip.timelineEndUs,
      ),
    );
    const clip = clips[index]!;
    running = true;
    advancing = false;
    const run = ++token;
    host.changed(true);
    active = 0;
    const slot = slots[0];
    try {
      await load(slot, index, clip.sourceStartUs + (at - clip.timelineStartUs));
      if (run !== token) return;
      await slot.video.play();
    } catch {
      finish(at, unplayable);
      return;
    }
    if (run !== token) return;
    slot.video.hidden = false;
    host.canvas.hidden = true;
    outputUs = at;
    follow(run);
    if (index + 1 < clips.length)
      void load(slots[1], index + 1, clips[index + 1]!.sourceStartUs);
    // Frame callbacks stop when a video stalls or ends; keep position honest.
    watchdog = setInterval(() => {
      if (run !== token || !running) return;
      const video = slotAt(active).video;
      if (video.ended) void advance(run);
      else if (!video.paused) tick(run, video.currentTime);
    }, 200);
  }

  return {
    toggle() {
      if (running) finish(outputUs);
      else void start();
    },
    stop() {
      if (running) finish(outputUs);
    },
    playing: () => running,
  };
}
