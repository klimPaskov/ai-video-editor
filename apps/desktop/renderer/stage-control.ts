/**
 * Drives the graphics stage page (`stage.html`). The same function runs in
 * the preview (on the stage iframe's document) and in export (injected into
 * an offscreen window), so both show identical pictures.
 *
 * It keeps one shadow root per graphic, so each graphic's CSS applies only
 * to its own HTML, and seeks every CSS animation of a graphic to the time
 * since that graphic started. The stage page itself runs no scripts.
 */
export interface StageGraphic {
  id: string;
  startUs: number;
  endUs: number;
  layer: number;
  html: string;
  css: string;
}

export interface StageState {
  width: number;
  height: number;
  /** Scale of the stage on screen (preview only). */
  scale: number;
  graphics: StageGraphic[];
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
  type Section = HTMLElement & { __content?: string; __shown?: boolean };
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
      section.attachShadow({ mode: "open" });
      stage.append(section);
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
