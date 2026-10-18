/**
 * Runs inside a sealed HyperFrames composition page (sandboxed frame, opaque
 * origin, no network). It answers the stage's seek messages through the
 * HyperFrames seek protocol (`window.__hf.seek`) and reports readiness and
 * the first script error, so preview, export and Claude's pictures show the
 * same frame for the same time.
 */
type HfWindow = Window & {
  __renderReady?: boolean;
  __hf?: { duration?: number; seek?(time: number, options?: unknown): void };
  /** The runtime's player; HyperFrames' producer wraps it as __hf.seek. */
  __player?: {
    renderSeek?(time: number, options?: unknown): void;
    getDuration?(): number;
  };
  __hfWaitForSeekCompletion?: () => Promise<unknown>;
};

const page = window as HfWindow;
let firstError: string | null = null;
const remember = (value: unknown) => {
  firstError ??= String(value).slice(0, 300);
};
window.addEventListener("error", (event) => remember(event.message));
window.addEventListener("unhandledrejection", (event) =>
  remember(event.reason),
);

/** The seek protocol: `__hf.seek` when a producer installed it, else the player. */
const seeker = (): ((time: number) => void) | null =>
  typeof page.__hf?.seek === "function"
    ? (time) => page.__hf!.seek!(time)
    : typeof page.__player?.renderSeek === "function"
      ? (time) => page.__player!.renderSeek!(time)
      : null;
const duration = (): number | null =>
  typeof page.__hf?.duration === "number"
    ? page.__hf.duration
    : typeof page.__player?.getDuration === "function"
      ? page.__player.getDuration()
      : null;
const ready = () => Boolean(page.__renderReady && seeker());

const painted = () =>
  new Promise<void>((done) =>
    requestAnimationFrame(() => requestAnimationFrame(() => done())),
  );

let queue: Promise<void> = Promise.resolve();
window.addEventListener("message", (event: MessageEvent) => {
  if (event.source !== window.parent) return;
  const data = event.data as {
    type?: unknown;
    id?: unknown;
    seconds?: unknown;
  } | null;
  if (
    data?.type !== "hf-seek" ||
    typeof data.id !== "number" ||
    typeof data.seconds !== "number" ||
    !Number.isFinite(data.seconds)
  )
    return;
  const { id, seconds } = data;
  // Seeks run one at a time, in order.
  queue = queue.then(async () => {
    const started = performance.now();
    while (!ready() && !firstError && performance.now() - started < 15_000)
      await new Promise((done) => setTimeout(done, 20));
    if (ready())
      try {
        seeker()!(Math.max(0, seconds));
        await page.__hfWaitForSeekCompletion?.();
      } catch (error) {
        remember(error);
      }
    await painted();
    window.parent.postMessage(
      {
        type: "hf-seeked",
        id,
        ready: ready() && !firstError,
        error: firstError,
        duration: duration(),
      },
      "*",
    );
  });
});

/** Why the runtime is not ready, in terms Claude can act on. */
const diagnosis = () => {
  const view = window as unknown as {
    __timelines?: Record<string, unknown>;
    gsap?: unknown;
  };
  return `The HyperFrames runtime did not become ready (runtime ${page.__hf ? "loaded" : "missing"}, seek ${seeker() ? "available" : "missing"}, render ready ${page.__renderReady === true}, timelines ${JSON.stringify(Object.keys(view.__timelines ?? {}))}, gsap ${typeof view.gsap === "undefined" ? "missing" : "loaded"}).`;
};

// Tell the stage once the runtime is ready, so a paused preview shows the
// right frame without waiting for the next seek.
void (async () => {
  const started = performance.now();
  while (!ready() && !firstError && performance.now() - started < 15_000)
    await new Promise((done) => setTimeout(done, 25));
  if (!ready() && !firstError) remember(diagnosis());
  window.parent.postMessage(
    { type: "hf-ready", ready: ready() && !firstError, error: firstError },
    "*",
  );
})();
