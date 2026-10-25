/**
 * A small library of designed motion graphics. Each kind is a finished
 * composition (layout, type, easing, entry and exit) that takes only content
 * and an accent colour, so the result looks designed every time instead of
 * improvised. They are ordinary graphics (HTML and CSS, no scripts), sized in
 * container units so they scale with the video, and clear of the title-safe
 * margin.
 */

export const graphicComponentKinds = [
  "lower_third",
  "chapter_card",
  "stat_callout",
  "highlight_box",
  "keyword",
  "step_badge",
] as const;
export type GraphicComponentKind = (typeof graphicComponentKinds)[number];

export interface GraphicComponentParams {
  /** Main text: a name, a title, a number or a phrase, by kind. */
  title: string;
  /** Second line, where the kind has one. */
  subtitle?: string;
  /** Accent colour as #RRGGBB. */
  accent?: string;
  /** Where it sits: left or right (lower third, stat, keyword, step). */
  side?: "left" | "right";
  /** Vertical placement: top, middle or bottom. */
  place?: "top" | "middle" | "bottom";
  /** Highlight box only: the area to frame, as fractions of the frame. */
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

export const graphicComponentLimits = Object.freeze({
  maxTitleChars: 60,
  maxSubtitleChars: 90,
  minDurationUs: 1_500_000,
});

export class GraphicComponentError extends Error {}

function fail(message: string): never {
  throw new GraphicComponentError(message);
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const defaultAccent = "#4f8cff";

function text(
  value: unknown,
  limit: number,
  what: string,
  required: boolean,
): string {
  if (value === undefined || value === "") {
    if (required) fail(`${what} is required.`);
    return "";
  }
  if (typeof value !== "string" || /[\u0000-\u001f\u007f]/u.test(value))
    fail(`${what} must be plain text.`);
  const trimmed = value.trim();
  if (required && !trimmed) fail(`${what} is required.`);
  if (trimmed.length > limit)
    fail(`${what} is too long (at most ${limit} characters).`);
  return trimmed;
}

function fraction(value: unknown, what: string): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  )
    fail(`${what} must be a fraction between 0 and 1.`);
  return value;
}

/** A readable text colour for a given accent, as a hex string. */
function onAccent(accent: string): string {
  const r = Number.parseInt(accent.slice(1, 3), 16);
  const g = Number.parseInt(accent.slice(3, 5), 16);
  const b = Number.parseInt(accent.slice(5, 7), 16);
  return (r * 299 + g * 587 + b * 114) / 1000 > 150 ? "#101319" : "#ffffff";
}

const shared = (seconds: number) => `
.gc-root{position:absolute;inset:0;container-type:size;font-family:Inter,"Segoe UI",system-ui,-apple-system,sans-serif;color:#fff}
.gc-exit{position:absolute;inset:0;animation:gc-exit .45s cubic-bezier(.4,0,1,1) ${(seconds - 0.45).toFixed(3)}s both}
@keyframes gc-exit{to{opacity:0;transform:translateY(1.2cqh)}}
@keyframes gc-rise{from{opacity:0;transform:translateY(2.4cqh)}to{opacity:1;transform:none}}
@keyframes gc-grow{from{transform:scaleX(0)}to{transform:scaleX(1)}}
@keyframes gc-pop{0%{opacity:0;transform:scale(.6)}70%{opacity:1;transform:scale(1.06)}100%{opacity:1;transform:scale(1)}}
@keyframes gc-fade{from{opacity:0}to{opacity:1}}
@keyframes gc-draw{from{clip-path:inset(-30% 100% -30% -6%)}to{clip-path:inset(-30% -6% -30% -6%)}}
`;

function placeStyles(
  side: "left" | "right",
  place: "top" | "middle" | "bottom",
): string {
  const horizontal = side === "left" ? "left:7cqw" : "right:7cqw";
  const vertical =
    place === "top"
      ? "top:9cqh"
      : place === "middle"
        ? "top:50cqh"
        : "bottom:10cqh";
  const shift = place === "middle" ? "transform:translateY(-50%);" : "";
  return `${horizontal};${vertical};${shift}`;
}

export interface RenderedGraphic {
  /** Short timeline label. */
  name: string;
  html: string;
  css: string;
}

/**
 * Renders a component for a graphic that stays on screen `durationUs`.
 * Throws `GraphicComponentError` with a reason the author can act on.
 */
export function renderGraphicComponent(
  kind: GraphicComponentKind,
  params: GraphicComponentParams,
  durationUs: number,
): RenderedGraphic {
  if (!graphicComponentKinds.includes(kind)) fail("Unknown graphic kind.");
  if (durationUs < graphicComponentLimits.minDurationUs)
    fail("A designed graphic needs at least 1.5 seconds on screen.");
  const seconds = durationUs / 1_000_000;
  const accent = params.accent ?? defaultAccent;
  if (!/^#[0-9a-fA-F]{6}$/u.test(accent))
    fail("accent must be a colour like #4f8cff.");
  const title = text(
    params.title,
    graphicComponentLimits.maxTitleChars,
    "title",
    true,
  );
  const subtitle = text(
    params.subtitle,
    graphicComponentLimits.maxSubtitleChars,
    "subtitle",
    false,
  );
  const side = params.side ?? "left";
  if (side !== "left" && side !== "right") fail("side must be left or right.");
  const place = params.place ?? "bottom";
  if (!["top", "middle", "bottom"].includes(place))
    fail("place must be top, middle or bottom.");
  const ink = onAccent(accent);
  const safeTitle = escapeHtml(title);
  const safeSubtitle = escapeHtml(subtitle);
  const align = side === "left" ? "left" : "right";
  const flex = side === "left" ? "flex-start" : "flex-end";

  switch (kind) {
    case "lower_third": {
      const html = `<div class="gc-root"><div class="gc-exit"><div class="lt"><span class="lt-bar"></span><span class="lt-text"><span class="lt-title">${safeTitle}</span>${subtitle ? `<span class="lt-sub">${safeSubtitle}</span>` : ""}</span></div></div></div>`;
      const css = `${shared(seconds)}
.lt{position:absolute;${placeStyles(side, place === "middle" ? "bottom" : place)}display:flex;align-items:stretch;gap:1.6cqw;flex-direction:${side === "left" ? "row" : "row-reverse"};animation:gc-fade .3s ease-out both}
.lt-bar{width:.7cqw;min-width:5px;border-radius:99px;background:${accent};transform-origin:top;animation:lt-bar .5s cubic-bezier(.2,.8,.2,1) both}
@keyframes lt-bar{from{transform:scaleY(0)}to{transform:scaleY(1)}}
.lt-text{display:flex;flex-direction:column;gap:.6cqh;padding:1.8cqh 2.6cqw;border-radius:1.2cqw;background:rgba(10,13,20,.78);text-align:${align}}
.lt-title{font-size:3.4cqw;font-weight:700;letter-spacing:-.01em;line-height:1.1;animation:gc-rise .55s .15s cubic-bezier(.2,.8,.2,1) both}
.lt-sub{font-size:2cqw;font-weight:500;color:rgba(255,255,255,.82);animation:gc-rise .55s .3s cubic-bezier(.2,.8,.2,1) both}`;
      return { name: `Lower third: ${title}`.slice(0, 80), html, css };
    }
    case "chapter_card": {
      const html = `<div class="gc-root"><div class="gc-exit"><div class="cc"><span class="cc-kicker">${safeSubtitle || "&nbsp;"}</span><span class="cc-title">${safeTitle}</span><span class="cc-line"></span></div></div></div>`;
      const css = `${shared(seconds)}
.cc{position:absolute;inset:0;display:flex;flex-direction:column;justify-content:center;align-items:${flex};padding:0 9cqw;gap:1.6cqh;background:linear-gradient(${side === "left" ? "90deg" : "270deg"},rgba(8,10,16,.82) 0%,rgba(8,10,16,.55) 55%,rgba(8,10,16,0) 100%);animation:gc-fade .5s ease-out both;text-align:${align}}
.cc-kicker{font-size:2cqw;font-weight:600;letter-spacing:.18em;text-transform:uppercase;color:${accent};animation:gc-rise .6s .1s cubic-bezier(.2,.8,.2,1) both;${subtitle ? "" : "visibility:hidden"}}
.cc-title{font-size:6.4cqw;font-weight:800;letter-spacing:-.025em;line-height:1.04;max-width:70cqw;animation:gc-rise .7s .25s cubic-bezier(.2,.8,.2,1) both}
.cc-line{height:.5cqh;width:16cqw;border-radius:99px;background:${accent};transform-origin:${side === "left" ? "left" : "right"};animation:gc-grow .8s .5s cubic-bezier(.2,.8,.2,1) both}`;
      return { name: `Chapter: ${title}`.slice(0, 80), html, css };
    }
    case "stat_callout": {
      const html = `<div class="gc-root"><div class="gc-exit"><div class="st"><span class="st-value">${safeTitle}</span>${subtitle ? `<span class="st-label">${safeSubtitle}</span>` : ""}</div></div></div>`;
      const css = `${shared(seconds)}
.st{position:absolute;${placeStyles(side, place)}display:flex;flex-direction:column;align-items:${flex};gap:.8cqh;padding:2.4cqh 3cqw;border-radius:1.6cqw;background:rgba(10,13,20,.8);border-top:.5cqh solid ${accent};text-align:${align};animation:gc-pop .6s cubic-bezier(.2,.8,.2,1) both}
.st-value{font-size:8cqw;font-weight:800;letter-spacing:-.03em;line-height:1;color:#fff;font-variant-numeric:tabular-nums}
.st-label{font-size:2.3cqw;font-weight:500;color:rgba(255,255,255,.85);max-width:30cqw;animation:gc-rise .5s .3s cubic-bezier(.2,.8,.2,1) both}`;
      return { name: `Stat: ${title}`.slice(0, 80), html, css };
    }
    case "highlight_box": {
      const x = fraction(params.x, "x");
      const y = fraction(params.y, "y");
      const width = fraction(params.width, "width");
      const height = fraction(params.height, "height");
      if (
        width < 0.02 ||
        height < 0.02 ||
        x + width > 1.001 ||
        y + height > 1.001
      )
        fail(
          "The highlighted area must lie inside the frame and be at least 2% wide and tall.",
        );
      const html = `<div class="gc-root"><div class="gc-exit"><div class="hb"><span class="hb-frame"></span><span class="hb-tag">${safeTitle}</span></div></div></div>`;
      const labelBelow = y + height < 0.88;
      const css = `${shared(seconds)}
.hb{position:absolute;left:${(x * 100).toFixed(2)}cqw;top:${(y * 100).toFixed(2)}cqh;width:${(width * 100).toFixed(2)}cqw;height:${(height * 100).toFixed(2)}cqh}
.hb-frame{position:absolute;inset:0;box-sizing:border-box;border:.45cqw solid ${accent};border-radius:1cqw;box-shadow:0 0 0 .2cqw rgba(0,0,0,.35),0 0 3cqw ${accent}66;animation:gc-draw .6s cubic-bezier(.2,.8,.2,1) both,hb-pulse 1.6s 1s ease-in-out infinite}
@keyframes hb-pulse{0%,100%{box-shadow:0 0 0 .2cqw rgba(0,0,0,.35),0 0 3cqw ${accent}66}50%{box-shadow:0 0 0 .2cqw rgba(0,0,0,.35),0 0 5cqw ${accent}aa}}
.hb-tag{position:absolute;left:0;${labelBelow ? "top:calc(100% + 1.2cqh)" : "bottom:calc(100% + 1.2cqh)"};white-space:nowrap;font-size:2.2cqw;font-weight:700;padding:.8cqh 1.6cqw;border-radius:99px;background:${accent};color:${ink};animation:gc-rise .5s .45s cubic-bezier(.2,.8,.2,1) both}`;
      return { name: `Highlight: ${title}`.slice(0, 80), html, css };
    }
    case "keyword": {
      const html = `<div class="gc-root"><div class="gc-exit"><div class="kw"><span class="kw-text">${safeTitle}</span><span class="kw-line"></span></div></div></div>`;
      const css = `${shared(seconds)}
.kw{position:absolute;${placeStyles(side, place === "bottom" ? "bottom" : place)}display:flex;flex-direction:column;align-items:${flex};gap:1cqh}
.kw-text{font-size:7cqw;font-weight:800;letter-spacing:-.025em;line-height:1.05;text-shadow:0 .4cqh 2cqh rgba(0,0,0,.65),0 0 .6cqh rgba(0,0,0,.6);animation:gc-draw .7s cubic-bezier(.2,.8,.2,1) both}
.kw-line{height:.9cqh;width:100%;border-radius:99px;background:${accent};transform-origin:${side === "left" ? "left" : "right"};animation:gc-grow .7s .3s cubic-bezier(.2,.8,.2,1) both}`;
      return { name: `Keyword: ${title}`.slice(0, 80), html, css };
    }
    case "step_badge": {
      const number = subtitle || "1";
      if (!/^\d{1,2}$/u.test(number))
        fail("For a step, subtitle is the step number (1–99).");
      const html = `<div class="gc-root"><div class="gc-exit"><div class="sb"><span class="sb-num">${escapeHtml(number)}</span><span class="sb-text">${safeTitle}</span></div></div></div>`;
      const css = `${shared(seconds)}
.sb{position:absolute;${placeStyles(side, place)}display:flex;align-items:center;gap:1.4cqw;padding:1.2cqh 2.4cqw 1.2cqh 1.2cqh;border-radius:99px;background:rgba(10,13,20,.82);animation:gc-fade .35s ease-out both}
.sb-num{display:grid;place-items:center;width:5.6cqw;height:5.6cqw;border-radius:50%;background:${accent};color:${ink};font-size:3cqw;font-weight:800;animation:gc-pop .55s cubic-bezier(.2,.8,.2,1) both}
.sb-text{font-size:2.8cqw;font-weight:600;animation:gc-rise .5s .2s cubic-bezier(.2,.8,.2,1) both}`;
      return { name: `Step ${number}: ${title}`.slice(0, 80), html, css };
    }
  }
}
