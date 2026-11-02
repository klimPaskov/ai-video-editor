/**
 * Drives the graphics stage page (`stage.html`). The same function runs in
 * the preview (on the stage iframe's document) and in export (injected into
 * an offscreen window), so both show identical pictures.
 *
 * It keeps one shadow root per graphic, so each graphic's CSS applies only
 * to its own HTML, and seeks every CSS animation of a graphic to the time
 * since that graphic started. The stage page itself runs no scripts.
 *
 * A HyperFrames composition graphic plays in a sandboxed frame of its own
 * (opaque origin, no network). The stage only posts it seek messages; the
 * composition's bridge seeks the HyperFrames runtime and confirms, and
 * `settleStage` waits for those confirmations before export captures.
 */
export interface StageGraphic {
  id: string;
  startUs: number;
  endUs: number;
  layer: number;
  html: string;
  css: string;
  /** SHA-256 of a stored HyperFrames composition. */
  composition?: string;
}

export interface StageState {
  width: number;
  height: number;
  /** Scale of the stage on screen (preview only). */
  scale: number;
  graphics: StageGraphic[];
  /** Where compositions are served, e.g. "app-scheme://composition/". */
  compositionBase?: string;
  /** Ask compositions to audit each seek (`composition.check`). */
  inspect?: boolean;
}

/**
 * Shows the graphics on screen at output time `us`. Returns true when the
 * picture may differ from the previous call (graphics appeared, left, or
 * have an animation in progress), so export can reuse an unchanged frame.
 */
export function syncStage(
  doc: Document,
  state: StageState,
  us: number,
): boolean {
  const stage = doc.getElementById("stage") as HTMLElement | null;
  if (!stage) return true;
  const root = stage as HTMLElement & { __stageKey?: string };
  const key = `${state.width}x${state.height}@${state.scale}`;
  if (root.__stageKey !== key) {
    root.__stageKey = key;
    stage.style.width = `${state.width}px`;
    stage.style.height = `${state.height}px`;
    stage.style.transform = state.scale === 1 ? "" : `scale(${state.scale})`;
    stage.style.setProperty("--stage-width", `${state.width}px`);
    stage.style.setProperty("--stage-height", `${state.height}px`);
    // Titles and text stay inside this margin.
    stage.style.setProperty(
      "--safe-inset",
      `${Math.round(Math.min(state.width, state.height) * 0.06)}px`,
    );
  }
  let changed = false;
  const wanted = new Map(
    state.graphics
      .filter((graphic) => us >= graphic.startUs && us < graphic.endUs)
      .map((graphic) => [graphic.id, graphic]),
  );
  type Section = HTMLElement & {
    __content?: string;
    __shown?: boolean;
    __seek?: number;
    __seekSeconds?: number;
    __acked?: number;
    __ready?: boolean;
    __error?: string | null;
    __inspect?: boolean;
    __report?: unknown;
    __duration?: number | null;
  };
  // Composition frames answer seeks with a message; remember the answers.
  const view = doc.defaultView as
    (Window & { __stageListening?: boolean; __stageSeek?: number }) | null;
  if (view && !view.__stageListening) {
    view.__stageListening = true;
    view.addEventListener("message", (event: MessageEvent) => {
      const data = event.data as {
        type?: unknown;
        id?: unknown;
        ready?: unknown;
        error?: unknown;
        duration?: unknown;
        report?: unknown;
      } | null;
      if (data?.type === "hf-ready") {
        // The frame just started listening: give it the latest seek.
        for (const frame of doc.querySelectorAll<HTMLIFrameElement>(
          "#stage iframe",
        )) {
          if (frame.contentWindow !== event.source) continue;
          const owner = frame.parentElement as Section;
          if (data.ready !== true)
            owner.__error =
              typeof data.error === "string" ? data.error.slice(0, 300) : null;
          frame.contentWindow?.postMessage(
            {
              type: "hf-seek",
              id: owner.__seek ?? 0,
              seconds: owner.__seekSeconds ?? 0,
              inspect: owner.__inspect === true,
            },
            "*",
          );
        }
        return;
      }
      if (data?.type !== "hf-seeked" || typeof data.id !== "number") return;
      for (const frame of doc.querySelectorAll<HTMLIFrameElement>(
        "#stage iframe",
      )) {
        if (frame.contentWindow !== event.source) continue;
        const owner = frame.parentElement as Section;
        owner.__acked = Math.max(owner.__acked ?? 0, data.id);
        owner.__ready = data.ready === true;
        owner.__error =
          typeof data.error === "string" ? data.error.slice(0, 300) : null;
        owner.__duration =
          typeof data.duration === "number" && Number.isFinite(data.duration)
            ? data.duration
            : null;
        owner.__report = data.report ?? null;
      }
    });
  }
  for (const section of [...stage.children] as Section[]) {
    const id = section.dataset.graphic ?? "";
    if (!state.graphics.some((graphic) => graphic.id === id)) {
      section.remove();
      changed = true;
    }
  }
  for (const graphic of state.graphics) {
    let section = stage.querySelector<Section>(
      `section[data-graphic="${CSS.escape(graphic.id)}"]`,
    );
    const visible = wanted.has(graphic.id);
    if (!section && !visible) continue;
    if (!section) {
      section = doc.createElement("section") as Section;
      section.dataset.graphic = graphic.id;
      if (!graphic.composition) section.attachShadow({ mode: "open" });
      stage.append(section);
    }
    if (graphic.composition) {
      const source = `${state.compositionBase ?? ""}${graphic.composition}.html`;
      let frame = section.querySelector("iframe");
      if (!frame || section.__content !== source) {
        section.__content = source;
        frame = doc.createElement("iframe");
        // Scripts run, but in an opaque origin with no network or parent.
        frame.setAttribute("sandbox", "allow-scripts");
        frame.setAttribute("aria-hidden", "true");
        frame.setAttribute("tabindex", "-1");
        frame.style.cssText =
          // The frame's color scheme matches the composition's root, or the
          // browser paints an opaque backdrop under it.
          "position:absolute;inset:0;width:100%;height:100%;border:0;background:transparent;pointer-events:none;color-scheme:normal";
        frame.src = source;
        section.style.cssText = "position:absolute;inset:0";
        section.replaceChildren(frame);
        section.__ready = false;
        section.__acked = 0;
        changed = true;
      }
      section.style.zIndex = String(graphic.layer);
      if (section.__shown !== visible) {
        section.__shown = visible;
        section.style.display = visible ? "" : "none";
        changed = true;
      }
      if (!visible) continue;
      if (view) {
        view.__stageSeek = (view.__stageSeek ?? 0) + 1;
        section.__seek = view.__stageSeek;
        // Kept so settleStage can resend it until the frame is listening.
        section.__seekSeconds = (us - graphic.startUs) / 1_000_000;
        section.__inspect = state.inspect === true;
        section.__report = null;
        frame.contentWindow?.postMessage(
          {
            type: "hf-seek",
            id: section.__seek,
            seconds: (us - graphic.startUs) / 1_000_000,
            inspect: section.__inspect,
          },
          "*",
        );
      }
      // A composition is animated code: assume every frame can differ.
      changed = true;
      continue;
    }
    const content = `${graphic.css}\u0000${graphic.html}`;
    if (section.__content !== content) {
      section.__content = content;
      const style = doc.createElement("style");
      style.textContent = graphic.css;
      const body = doc.createElement("div");
      body.className = "graphic";
      body.style.cssText = "position:absolute;inset:0";
      body.innerHTML = graphic.html;
      section.shadowRoot!.replaceChildren(style, body);
      changed = true;
    }
    section.style.zIndex = String(graphic.layer);
    if (section.__shown !== visible) {
      section.__shown = visible;
      section.style.display = visible ? "" : "none";
      changed = true;
    }
    if (!visible) continue;
    const localMs = (us - graphic.startUs) / 1000;
    for (const animation of section.shadowRoot!.getAnimations()) {
      animation.pause();
      animation.currentTime = localMs;
      const timing = animation.effect?.getComputedTiming();
      const end = Number(timing?.endTime ?? 0);
      // An animation still running (or with no end) changes the picture.
      if (!Number.isFinite(end) || localMs <= end) changed = true;
    }
  }
  return changed;
}

/**
 * Waits until every visible composition has confirmed its latest seek (or
 * `timeoutMs` passes). Resolves to null when all are ready, otherwise to the
 * first reason a composition is not.
 */
export function settleStage(
  doc: Document,
  timeoutMs: number,
): Promise<string | null> {
  type Section = HTMLElement & {
    __seek?: number;
    __seekSeconds?: number;
    __acked?: number;
    __ready?: boolean;
    __error?: string | null;
    __shown?: boolean;
    __inspect?: boolean;
  };
  // A seek posted before the frame loaded is lost; resend the latest one.
  let lastResend = 0;
  const pending = () =>
    [...doc.querySelectorAll<Section>("#stage section")].filter(
      (section) =>
        section.querySelector("iframe") &&
        section.__shown &&
        (section.__acked ?? 0) < (section.__seek ?? 0),
    );
  const started = Date.now();
  return new Promise((resolve) => {
    const check = () => {
      const waiting = pending();
      if (!waiting.length) {
        const broken = [
          ...doc.querySelectorAll<Section>("#stage section"),
        ].find(
          (section) =>
            section.querySelector("iframe") &&
            section.__shown &&
            !section.__ready,
        );
        resolve(
          broken
            ? (broken.__error ?? "The composition did not become ready.")
            : null,
        );
        return;
      }
      if (Date.now() - lastResend > 250) {
        lastResend = Date.now();
        for (const section of waiting)
          section.querySelector("iframe")?.contentWindow?.postMessage(
            {
              type: "hf-seek",
              id: section.__seek,
              seconds: section.__seekSeconds ?? 0,
              inspect: section.__inspect === true,
            },
            "*",
          );
      }
      if (Date.now() - started > timeoutMs) {
        resolve(
          waiting[0]!.__error ?? "The composition did not answer in time.",
        );
        return;
      }
      setTimeout(check, 10);
    };
    check();
  });
}

/**
 * The latest answer of the stage's first composition, for
 * `composition.check`: whether it is ready, its error, its duration in
 * seconds and the audit of the last seek.
 */
export function stageReport(doc: Document): {
  ready: boolean;
  error: string | null;
  duration: number | null;
  report: unknown;
} | null {
  const section = doc.querySelector("#stage section") as
    | (HTMLElement & {
        __ready?: boolean;
        __error?: string | null;
        __duration?: number | null;
        __report?: unknown;
      })
    | null;
  if (!section?.querySelector("iframe")) return null;
  return {
    ready: section.__ready === true,
    error: section.__error ?? null,
    duration: section.__duration ?? null,
    report: section.__report ?? null,
  };
}
