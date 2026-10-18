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

/** Text on screen now, as `composition.check` audits it. */
interface TextFinding {
  code: "text_cut_off" | "text_outside_safe_area" | "text_too_small";
  text: string;
  /** The text's box in canvas pixels: x, y, width, height. */
  box: [number, number, number, number];
  font_px?: number;
}

/**
 * Audits the composition at the current seek: visible text cut off by the
 * canvas edge, outside the title-safe margin, or too small to read. The
 * stage uses the same 6% margin for its own graphics.
 */
const inspect = (): { findings: TextFinding[]; animations: number } => {
  const width = window.innerWidth;
  const height = window.innerHeight;
  const inset = Math.round(Math.min(width, height) * 0.06);
  // About 24 px at 1080p: smaller text is hard to read on a phone.
  const minimumFont = Math.max(12, Math.round(Math.min(width, height) * 0.022));
  const findings: TextFinding[] = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = (node.textContent ?? "").replace(/\s+/gu, " ").trim();
    const element = node.parentElement;
    if (!text || !element || element.closest("script,style,template,noscript"))
      continue;
    if (
      !element.checkVisibility({
        opacityProperty: true,
        visibilityProperty: true,
      })
    )
      continue;
    // Effective opacity and scale through every ancestor.
    let opacity = 1;
    let scale = 1;
    for (let item: Element | null = element; item; item = item.parentElement) {
      const style = getComputedStyle(item);
      opacity *= Number(style.opacity);
      if (style.transform && style.transform !== "none") {
        const matrix = new DOMMatrix(style.transform);
        scale *= Math.hypot(matrix.a, matrix.b);
      }
    }
    if (opacity < 0.05) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    const box = range.getBoundingClientRect();
    if (box.width < 1 || box.height < 1) continue;
    // Entirely off the canvas is an element waiting to enter, not a problem.
    if (
      box.right <= 0 ||
      box.bottom <= 0 ||
      box.left >= width ||
      box.top >= height
    )
      continue;
    const finding = (code: TextFinding["code"], extra = {}) =>
      findings.push({
        code,
        text: text.slice(0, 60),
        box: [box.left, box.top, box.width, box.height].map(Math.round) as [
          number,
          number,
          number,
          number,
        ],
        ...extra,
      });
    const tolerance = 2;
    if (
      box.left < -tolerance ||
      box.top < -tolerance ||
      box.right > width + tolerance ||
      box.bottom > height + tolerance
    )
      finding("text_cut_off");
    else if (
      box.left < inset ||
      box.top < inset ||
      box.right > width - inset ||
      box.bottom > height - inset
    )
      finding("text_outside_safe_area");
    const font = parseFloat(getComputedStyle(element).fontSize) * scale;
    if (Number.isFinite(font) && font < minimumFont)
      finding("text_too_small", { font_px: Math.round(font * 10) / 10 });
    if (findings.length >= 24) break;
  }
  return { findings, animations: document.getAnimations().length };
};

/** The root's declared canvas (`data-width`/`data-height`), if any. */
const declaredSize = () => {
  const root = document.querySelector("[data-composition-id]");
  const width = Number(root?.getAttribute("data-width"));
  const height = Number(root?.getAttribute("data-height"));
  return width > 0 && height > 0 ? { width, height } : null;
};

/** Timelines the composition registered, for `composition.check`. */
const timelines = () =>
  Object.keys(
    (window as unknown as { __timelines?: Record<string, unknown> })
      .__timelines ?? {},
  ).slice(0, 16);

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
    inspect?: unknown;
  } | null;
  if (
    data?.type !== "hf-seek" ||
    typeof data.id !== "number" ||
    typeof data.seconds !== "number" ||
    !Number.isFinite(data.seconds)
  )
    return;
  const { id, seconds } = data;
  const audit = data.inspect === true;
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
    let report: unknown = null;
    if (audit)
      try {
        report = {
          ...inspect(),
          timelines: timelines(),
          declared_size: declaredSize(),
        };
      } catch (error) {
        remember(error);
      }
    window.parent.postMessage(
      {
        type: "hf-seeked",
        id,
        ready: ready() && !firstError,
        error: firstError,
        duration: duration(),
        ...(audit ? { report } : {}),
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
