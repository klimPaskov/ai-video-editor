import type { Page } from "playwright/test";

export interface LayoutFinding {
  kind:
    | "page-overflow"
    | "outside-window"
    | "clipped"
    | "overlap"
    | "text-clipped"
    | "tiny-target"
    | "contrast"
    | "primary-action";
  detail: string;
}

/**
 * Looks at the page as it is and reports what a person would call broken:
 * the page scrolling sideways, a control cut off by the window or by a
 * container that hides overflow, two controls drawn over each other, text
 * cut off without an ellipsis, and targets too small to press. Controls
 * inside a scrolling container may sit below the fold; only sideways and
 * hidden-overflow cuts count there.
 */
export async function auditLayout(page: Page): Promise<LayoutFinding[]> {
  return page.evaluate(() => {
    const findings: LayoutFinding[] = [];
    const add = (kind: LayoutFinding["kind"], detail: string) => {
      if (findings.length < 40) findings.push({ kind, detail });
    };
    const label = (element: Element): string => {
      const own =
        element.getAttribute("aria-label") ||
        (element as HTMLElement).innerText
          ?.trim()
          .replace(/\s+/gu, " ")
          .slice(0, 30) ||
        "";
      return `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ""}${own ? ` "${own}"` : ""}`;
    };
    const visible = (element: Element): boolean => {
      for (
        let node: Element | null = element;
        node;
        node = node.parentElement
      ) {
        const style = getComputedStyle(node);
        if (
          style.display === "none" ||
          style.visibility === "hidden" ||
          (node as HTMLElement).hidden
        )
          return false;
        if (node.tagName === "DETAILS" && !(node as HTMLDetailsElement).open) {
          // Only the summary of a closed disclosure shows.
          if (
            element.tagName !== "SUMMARY" &&
            !element.closest("summary") &&
            node !== element
          )
            return false;
        }
      }
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const width = window.innerWidth;
    const height = window.innerHeight;
    const scrolling = document.scrollingElement!;
    if (scrolling.scrollWidth > width + 1)
      add(
        "page-overflow",
        `the page is ${scrolling.scrollWidth}px wide in a ${width}px window`,
      );

    const modal = document.querySelector("dialog[open]");
    const inScope = (element: Element) => !modal || modal.contains(element);
    const scrolledAway = (element: Element): boolean => {
      // Reachable by scrolling its container, so not a layout fault.
      const rect = element.getBoundingClientRect();
      for (let node = element.parentElement; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (!/(auto|scroll)/u.test(style.overflowY)) continue;
        const box = node.getBoundingClientRect();
        if (rect.bottom < box.top + 1 || rect.top > box.bottom - 1) return true;
      }
      return false;
    };
    const controls = Array.from(
      document.querySelectorAll(
        "button, input:not([type=hidden]), select, textarea, a[href], summary, [role=radio], [role=tab]",
      ),
    ).filter(
      (element) =>
        visible(element) && inScope(element) && !scrolledAway(element),
    );

    // Containers that cut their content off, and ones that scroll it.
    const clipper = (
      element: Element,
    ): { cut: DOMRect | null; scrollsY: boolean } => {
      let cut: DOMRect | null = null;
      let scrollsY = false;
      for (let node = element.parentElement; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (/(auto|scroll)/u.test(style.overflowY)) scrollsY = true;
        if (
          /(hidden|clip)/u.test(style.overflowX) ||
          /(auto|scroll)/u.test(style.overflowX)
        ) {
          const rect = node.getBoundingClientRect();
          cut = cut
            ? new DOMRect(
                Math.max(cut.left, rect.left),
                cut.top,
                Math.min(cut.right, rect.right) - Math.max(cut.left, rect.left),
                cut.height,
              )
            : rect;
        }
      }
      return { cut, scrollsY };
    };

    /** The part of a control that is drawn: its box cut by every clipping ancestor. */
    const shown = (element: Element): DOMRect | null => {
      let left = element.getBoundingClientRect().left;
      let right = element.getBoundingClientRect().right;
      let top = element.getBoundingClientRect().top;
      let bottom = element.getBoundingClientRect().bottom;
      for (let node = element.parentElement; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (
          !/(hidden|clip|auto|scroll)/u.test(style.overflowX + style.overflowY)
        )
          continue;
        const rect = node.getBoundingClientRect();
        if (/(hidden|clip|auto|scroll)/u.test(style.overflowX)) {
          left = Math.max(left, rect.left);
          right = Math.min(right, rect.right);
        }
        if (/(hidden|clip|auto|scroll)/u.test(style.overflowY)) {
          top = Math.max(top, rect.top);
          bottom = Math.min(bottom, rect.bottom);
        }
      }
      return right > left && bottom > top
        ? new DOMRect(left, top, right - left, bottom - top)
        : null;
    };

    for (const element of controls) {
      const rect = element.getBoundingClientRect();
      const name = label(element);
      if (rect.left < -1 || rect.right > width + 1)
        add(
          "outside-window",
          `${name} is cut off sideways (${Math.round(rect.left)}..${Math.round(rect.right)} of ${width})`,
        );
      const { cut, scrollsY } = clipper(element);
      if (!scrollsY && (rect.top < -1 || rect.bottom > height + 1))
        add(
          "outside-window",
          `${name} is below or above the window (${Math.round(rect.top)}..${Math.round(rect.bottom)} of ${height})`,
        );
      if (cut && (rect.left < cut.left - 1 || rect.right > cut.right + 1))
        add("clipped", `${name} is cut off by its container`);
      const small = Math.min(rect.width, rect.height);
      const isCheck =
        (element as HTMLInputElement).type === "checkbox" ||
        (element as HTMLInputElement).type === "radio" ||
        (element as HTMLInputElement).type === "range";
      if (!isCheck && small < 20)
        add(
          "tiny-target",
          `${name} is only ${Math.round(rect.width)}x${Math.round(rect.height)}px`,
        );
    }

    // Two controls drawn over each other.
    for (let i = 0; i < controls.length; i++)
      for (let j = i + 1; j < controls.length; j++) {
        const a = controls[i]!;
        const b = controls[j]!;
        if (a.contains(b) || b.contains(a)) continue;
        // A control and the label wrapping it are one thing.
        if (a.closest("label") && a.closest("label") === b.closest("label"))
          continue;
        // The options button sits over its project card by design.
        if (
          a.classList.contains("card-options") ||
          b.classList.contains("card-options")
        )
          continue;
        // Only what is drawn counts: a control half scrolled under the edge
        // of its container is cut off there, not drawn over its neighbours.
        const ra = shown(a);
        const rb = shown(b);
        if (!ra || !rb) continue;
        const w = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
        const h = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
        if (w > 3 && h > 3)
          add(
            "overlap",
            `${label(a)} overlaps ${label(b)} by ${Math.round(w)}x${Math.round(h)}px`,
          );
      }

    // Text cut off without an ellipsis.
    for (const element of document.querySelectorAll<HTMLElement>(
      "button, label, h1, h2, h3, p, span, strong, summary, legend, li, td",
    )) {
      if (!visible(element) || element.closest(".visually-hidden")) continue;
      const style = getComputedStyle(element);
      if (!/(hidden|clip)/u.test(style.overflowX)) continue;
      if (style.textOverflow === "ellipsis") continue;
      if (
        element.scrollWidth > element.clientWidth + 2 &&
        element.clientWidth > 0
      )
        add(
          "text-clipped",
          `${label(element)} text is cut off (${element.scrollWidth} in ${element.clientWidth}px)`,
        );
    }

    // Text a person could not read against what is behind it.
    const channels = (
      value: string,
    ): [number, number, number, number] | null => {
      const match = /rgba?\(([^)]+)\)/u.exec(value);
      if (!match) return null;
      const parts = match[1]!
        .split(/[ ,/]+/u)
        .filter(Boolean)
        .map(Number);
      return [parts[0]!, parts[1]!, parts[2]!, parts[3] ?? 1];
    };
    const over = (
      top: [number, number, number, number],
      below: [number, number, number],
    ): [number, number, number] => [
      top[0] * top[3] + below[0] * (1 - top[3]),
      top[1] * top[3] + below[1] * (1 - top[3]),
      top[2] * top[3] + below[2] * (1 - top[3]),
    ];
    const lum = (c: [number, number, number]) => {
      const f = (v: number) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
    };
    const background = (element: Element): [number, number, number] => {
      const layers: Array<[number, number, number, number]> = [];
      for (
        let node: Element | null = element;
        node;
        node = node.parentElement
      ) {
        const value = channels(getComputedStyle(node).backgroundColor);
        if (value && value[3] > 0) {
          layers.push(value);
          if (value[3] >= 1) break;
        }
      }
      let result: [number, number, number] = [255, 255, 255];
      for (const layer of layers.reverse()) result = over(layer, result);
      return result;
    };
    const seen = new Set<string>();
    for (const element of document.querySelectorAll<HTMLElement>(
      "button, label, h1, h2, h3, p, span, strong, summary, legend, li, option, a, output, dt, dd",
    )) {
      if (!visible(element) || !inScope(element) || scrolledAway(element))
        continue;
      if (
        element.closest(
          ".visually-hidden, [disabled], [aria-disabled=true], canvas, video",
        )
      )
        continue;
      const own = Array.from(element.childNodes).some(
        (node) =>
          node.nodeType === Node.TEXT_NODE &&
          node.textContent!.trim().length > 0,
      );
      if (!own) continue;
      const style = getComputedStyle(element);
      let opacity = 1;
      for (let node: Element | null = element; node; node = node.parentElement)
        opacity *= Number(getComputedStyle(node).opacity);
      const text = channels(style.color);
      if (!text) continue;
      const back = background(element);
      const front = over([text[0], text[1], text[2], text[3] * opacity], back);
      const a = lum(front);
      const b = lum(back);
      const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      const size = parseFloat(style.fontSize);
      const large =
        size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700);
      const need = large ? 3 : 4.5;
      if (ratio < need) {
        const key = `${label(element)}`;
        if (!seen.has(key)) {
          seen.add(key);
          add(
            "contrast",
            `${label(element)} is ${ratio.toFixed(1)}:1, needs ${need}:1`,
          );
        }
      }
    }
    return findings;
  });
}

/** The control a person presses to move a step forward, most important first. */
const primaryActions: Record<string, string[]> = {
  record_import: ["#next-step-button"],
  auto_edit: ["#auto-all-refine", "#auto-all-start"],
  edit: ["#next-step-button"],
  clips: ["#next-step-button"],
  export: ["#export-open", "#export-start"],
};

/** Why a trial click failed, in a few words. */
function whyNot(error: unknown): string {
  const line = String(error instanceof Error ? error.message : error)
    .split(/\r?\n/u)
    .find((text) => /intercepts|outside|not visible|not enabled/u.test(text));
  return line ? `: ${line.trim().slice(0, 140)}` : "";
}

/**
 * Two things must always work: the step's primary action (such as Continue)
 * and the way to another step. Both must be on screen and receive a click:
 * Playwright's trial click scrolls the control into view the way a person
 * would, then checks that it is visible, enabled, still and not covered by
 * anything else. It does not press the button.
 */
export async function checkPrimaryAction(page: Page): Promise<LayoutFinding[]> {
  const stage = await page.evaluate(
    () => document.getElementById("viewer")?.dataset.stage ?? "",
  );
  const findings: LayoutFinding[] = [];
  const candidates = primaryActions[stage];
  if (candidates) {
    let found = false;
    for (const selector of candidates) {
      const target = page.locator(selector);
      if (!(await target.isVisible())) continue;
      found = true;
      try {
        await target.click({ trial: true, timeout: 2_500 });
      } catch (error) {
        findings.push({
          kind: "primary-action",
          detail: `${selector} on ${stage} cannot be clicked${whyNot(error)}`,
        });
      }
      break;
    }
    if (!found)
      findings.push({
        kind: "primary-action",
        detail: `${stage} shows no primary action`,
      });
  }
  // The steps: the row of buttons, or the menu when the window is narrow.
  const targets = (await page.locator("#stage-buttons").isVisible())
    ? await page.locator("#stage-buttons button").all()
    : [page.locator("#stage-select")];
  for (const target of targets) {
    try {
      await target.click({ trial: true, timeout: 2_500 });
    } catch (error) {
      const name = (await target.getAttribute("aria-label")) ?? "stage menu";
      findings.push({
        kind: "primary-action",
        detail: `the ${name} step control on ${stage} cannot be clicked${whyNot(error)}`,
      });
    }
  }
  return findings;
}
