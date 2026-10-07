/**
 * Inline stroke icons for `[data-icon]` elements. Icons are decorative
 * (aria-hidden); every control keeps its text or aria-label as its name.
 * Several controls replace their text at runtime, so an observer puts the
 * icon back whenever an element loses it or its data-icon changes.
 */
const paths: Record<string, string> = {
  home: "M3 10.5 12 3l9 7.5M5 9v11h5v-6h4v6h5V9",
  settings:
    "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19.4 13a7.6 7.6 0 0 0 0-2l2-1.6-2-3.4-2.4.9a7.4 7.4 0 0 0-1.7-1L15 3h-4l-.4 2.6a7.4 7.4 0 0 0-1.7 1l-2.4-.9-2 3.4 2 1.6a7.6 7.6 0 0 0 0 2l-2 1.6 2 3.4 2.4-.9a7.4 7.4 0 0 0 1.7 1L11 21h4l.4-2.6a7.4 7.4 0 0 0 1.7-1l2.4.9 2-3.4Z",
  plus: "M12 5v14M5 12h14",
  sparkle:
    "M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8ZM19 15l.7 2.3L22 18l-2.3.7L19 21l-.7-2.3L16 18l2.3-.7Z",
  info: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 11v6M12 7.5v.5",
  close: "M6 6l12 12M18 6 6 18",
  "frame-back": "M18 6 10 12l8 6V6ZM6 6v12",
  "frame-forward": "M6 6l8 6-8 6V6ZM18 6v12",
  play: "M7 4.5v15L19.5 12 7 4.5Z",
  pause: "M8 5v14M16 5v14",
  stop: "M6 6h12v12H6Z",
  record: "M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10Z",
  "record-large":
    "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z",
  folder:
    "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z",
  "folder-large":
    "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2ZM12 10v6M9 13l3-3 3 3",
  wand: "M4 20 15 9M14 4l1 2 2 1-2 1-1 2-1-2-2-1 2-1ZM19 11l.6 1.4L21 13l-1.4.6L19 15l-.6-1.4L17 13l1.4-.6Z",
  transcript: "M5 4h14v16H5ZM8 8h8M8 12h8M8 16h5",
  "trim-start": "M8 4v16M8 12h12M16 8l4 4-4 4",
  "trim-end": "M16 4v16M16 12H4M8 8l-4 4 4 4",
  split: "M12 3v18M8 7H4v10h4M16 7h4v10h-4",
  undo: "M9 14 4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3",
  redo: "M15 14l5-5-5-5M20 9H9a5 5 0 0 0 0 10h3",
  "mark-in": "M8 4v16M8 4h6M8 20h6",
  "mark-out": "M16 4v16M16 4h-6M16 20h-6",
  scissors:
    "M6 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM8.1 7.9 20 18M8.1 16.1 20 6",
  clear: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM9 9l6 6M15 9l-6 6",
  restore: "M3 12a9 9 0 1 0 3-6.7M3 4v5h5",
  shield: "M12 3 5 6v6c0 4.2 3 7.6 7 9 4-1.4 7-4.8 7-9V6ZM9 12l2 2 4-4",
  export: "M12 15V3M7 8l5-5 5 5M5 14v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5",
  send: "M4 12 20 4l-6 16-3-7Z",
  film: "M4 4h16v16H4ZM8 4v16M16 4v16M4 8h4M4 16h4M16 8h4M16 16h4",
  monitor: "M3 5h18v11H3ZM8 20h8M12 16v4",
  mic: "M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3ZM5 11a7 7 0 0 0 14 0M12 18v3",
};
const filled = new Set(["play", "record", "stop"]);
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
