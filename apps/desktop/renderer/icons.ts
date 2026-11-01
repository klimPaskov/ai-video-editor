/**
 * Inline stroke icons for `[data-icon]` elements. Icons are decorative
 * (aria-hidden); every control keeps its text or aria-label as its name.
 * Several controls replace their text at runtime, so an observer puts the
 * icon back whenever an element loses it or its data-icon changes.
 *
 * One set, one grid: 24x24 with a 3px margin (live area 3..21), a 1.75
 * stroke, round caps and joins, corners rounded to 1.5 and outline circles of
 * radius 9. Solid glyphs (play, pause, stop, record) are filled shapes of the
 * same footprint.
 */
const paths: Record<string, string> = {
  home: "M4 11 12 4l8 7M6 9.5V19a1 1 0 0 0 1 1h3.5v-5.5h3V20H17a1 1 0 0 0 1-1V9.5",
  settings:
    "M4 8h7.8M16.2 8H20M4 16h3.8M12.2 16H20M14 5.8a2.2 2.2 0 1 0 0 4.4 2.2 2.2 0 0 0 0-4.4ZM10 13.8a2.2 2.2 0 1 0 0 4.4 2.2 2.2 0 0 0 0-4.4Z",
  plus: "M12 5v14M5 12h14",
  sparkle:
    "M10.5 6c.55 3.9 2.1 5.95 6 6.5-3.9.55-5.45 2.6-6 6.5-.55-3.9-2.1-5.95-6-6.5 3.9-.55 5.45-2.6 6-6.5ZM18.5 3.5v4M16.5 5.5h4",
  info: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 11v5.5M12 7.8v.2",
  close: "M6.5 6.5l11 11M17.5 6.5l-11 11",
  more: "M5 12a1 1 0 1 0 2 0 1 1 0 1 0-2 0M11 12a1 1 0 1 0 2 0 1 1 0 1 0-2 0M17 12a1 1 0 1 0 2 0 1 1 0 1 0-2 0",
  "frame-back": "M17.5 7v10L9.5 12ZM6.5 7v10",
  "frame-forward": "M6.5 7v10l8-5ZM17.5 7v10",
  fullscreen:
    "M4 9V5.5A1.5 1.5 0 0 1 5.5 4H9M15 4h3.5A1.5 1.5 0 0 1 20 5.5V9M20 15v3.5a1.5 1.5 0 0 1-1.5 1.5H15M9 20H5.5A1.5 1.5 0 0 1 4 18.5V15",
  play: "M8.5 6v12L18 12Z",
  pause: "M7.5 6h2.5v12H7.5ZM14 6h2.5v12H14Z",
  stop: "M7.5 7.5h9v9h-9Z",
  record: "M12 16.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9Z",
  "record-large":
    "M5.5 6.5h8a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-8a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2ZM15.5 10.5l5-2.5v8l-5-2.5",
  video:
    "M5.5 6.5h8a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-8a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2ZM15.5 10.5l5-2.5v8l-5-2.5",
  folder:
    "M3.5 7.5a2 2 0 0 1 2-2h3.6a2 2 0 0 1 1.5.7l1 1.1a2 2 0 0 0 1.5.7h5.4a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z",
  "folder-large":
    "M3.5 7.5a2 2 0 0 1 2-2h3.6a2 2 0 0 1 1.5.7l1 1.1a2 2 0 0 0 1.5.7h5.4a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2ZM12 16v-5M9.75 13.25 12 11l2.25 2.25",
  // A wand with a sparkle at its tip and a second, smaller one.
  wand: "M3.9 17.9 12.9 8.9l2.2 2.2-9 9ZM18 3c.3 2.2.8 2.7 3 3-2.2.3-2.7.8-3 3-.3-2.2-.8-2.7-3-3 2.2-.3 2.7-.8 3-3ZM6.5 3.5v3M5 5h3",
  transcript:
    "M7 3.5h10A1.5 1.5 0 0 1 18.5 5v14a1.5 1.5 0 0 1-1.5 1.5H7A1.5 1.5 0 0 1 5.5 19V5A1.5 1.5 0 0 1 7 3.5ZM9 8.5h6M9 12h6M9 15.5h3.5",
  "trim-start": "M7 5v14M11 12h9M16 8l4 4-4 4",
  "trim-end": "M17 5v14M13 12H4M8 8l-4 4 4 4",
  split:
    "M12 3.5v17M8.5 7h-3a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h3M15.5 7h3a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-3",
  undo: "M9 14 4.5 9.5 9 5M5 9.5h9a4.5 4.5 0 0 1 0 9h-4",
  redo: "M15 14l4.5-4.5L15 5M19 9.5h-9a4.5 4.5 0 0 0 0 9h4",
  "mark-in": "M9 5v14M9 5h5M9 19h5",
  "mark-out": "M15 5v14M15 5h-5M15 19h-5",
  scissors:
    "M6 9a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM6 20a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM8 8.2 20 18.5M8 15.8 20 5.5",
  clear:
    "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM9.2 9.2l5.6 5.6M14.8 9.2l-5.6 5.6",
  restore: "M3 12a9 9 0 1 0 3-6.7M3 4v5h5",
  shield:
    "M12 3.5 5 6.2v5.6c0 4.2 2.8 7.4 7 8.7 4.2-1.3 7-4.5 7-8.7V6.2ZM8.8 12l2.3 2.3 4.3-4.6",
  export: "M12 15V4M8 8l4-4 4 4M5 14.5V18a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3.5",
  send: "M20.5 3.5 10 14M20.5 3.5 14 20.5l-4-6.5-6.5-4Z",
  captions:
    "M5 5h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2ZM7 11h3M12 11h5M7 15h5M14 15h3",
  clips:
    "M5 5h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2ZM10.5 9.5v5l4-2.5Z",
  audio: "M4 10v4M8 7v10M12 4.5v15M16 8v8M20 10.5v3",
  transition:
    "M6 5.5h7A1.5 1.5 0 0 1 14.5 7v7a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 14V7A1.5 1.5 0 0 1 6 5.5ZM11 9.5h7a1.5 1.5 0 0 1 1.5 1.5v7a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 9.5 18v-7A1.5 1.5 0 0 1 11 9.5Z",
  zoom: "M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13ZM20 20l-4.9-4.9M10.5 7.5v6M7.5 10.5h6",
  speed: "M5 7l6 5-6 5ZM13 7l6 5-6 5Z",
  target:
    "M12 19a7 7 0 1 0 0-14 7 7 0 0 0 0 14ZM12 14.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21",
  film: "M5.5 4h13A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5v-13A1.5 1.5 0 0 1 5.5 4ZM8.5 4v16M15.5 4v16M4 9h4.5M4 15h4.5M15.5 9H20M15.5 15H20",
  monitor:
    "M5.5 4.5h13A1.5 1.5 0 0 1 20 6v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 15V6a1.5 1.5 0 0 1 1.5-1.5ZM9 20h6M12 16.5V20",
  mic: "M12 14.5a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v5.5a3 3 0 0 0 3 3ZM5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3",
};
const filled = new Set(["play", "pause", "record", "stop"]);
const svgNamespace = "http://www.w3.org/2000/svg";

function iconFor(name: string): SVGSVGElement | undefined {
  const d = paths[name];
  if (!d) return undefined;
  const svg = document.createElementNS(svgNamespace, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.classList.add("icon");
  svg.dataset.iconName = name;
  const path = document.createElementNS(svgNamespace, "path");
  path.setAttribute("d", d);
  if (filled.has(name)) svg.classList.add("filled");
  svg.append(path);
  return svg;
}

function apply(element: Element): void {
  const name = element.getAttribute("data-icon");
  const current = element.firstElementChild;
  const present =
    current instanceof SVGSVGElement && current.classList.contains("icon");
  if (present && current.dataset.iconName === name) return;
  if (present) current.remove();
  const icon = name ? iconFor(name) : undefined;
  if (icon) element.prepend(icon);
}

export function setupIcons(root: ParentNode = document): void {
  for (const element of root.querySelectorAll("[data-icon]")) apply(element);
  new MutationObserver((records) => {
    for (const record of records) {
      const target = record.target;
      if (target instanceof Element && target.hasAttribute("data-icon"))
        apply(target);
      for (const node of record.addedNodes)
        if (node instanceof Element) {
          if (node.hasAttribute("data-icon")) apply(node);
          for (const child of node.querySelectorAll("[data-icon]"))
            apply(child);
        }
    }
  }).observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["data-icon"],
  });
}

export function iconElement(name: string): SVGSVGElement {
  const icon = iconFor(name);
  if (!icon) throw new Error("Unknown icon");
  return icon;
}
