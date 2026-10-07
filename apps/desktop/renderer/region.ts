/**
 * Area picker shown over one display: drag a rectangle, then confirm it.
 * The result goes to main as fractions of the display.
 */
declare global {
  interface Window {
    regionPicker: {
      done(
        area: { x: number; y: number; width: number; height: number } | null,
      ): void;
    };
  }
}

const minimum = 32;
const selection = document.getElementById("selection")!;
const size = document.getElementById("size")!;
const actions = document.getElementById("actions")!;
const hint = document.getElementById("hint")!;
const confirm = document.getElementById("confirm") as HTMLButtonElement;
const cancel = document.getElementById("cancel") as HTMLButtonElement;
let start: { x: number; y: number } | null = null;
let rect: { x: number; y: number; width: number; height: number } | null = null;
let finished = false;

function finish(chosen: typeof rect): void {
  if (finished) return;
  finished = true;
  const width = window.innerWidth,
    height = window.innerHeight;
  window.regionPicker.done(
    chosen
      ? {
          x: chosen.x / width,
          y: chosen.y / height,
          width: chosen.width / width,
          height: chosen.height / height,
        }
      : null,
  );
}

function draw(): void {
  if (!rect) {
    selection.hidden = true;
    actions.hidden = true;
    document.body.classList.remove("chosen");
    return;
  }
  selection.hidden = false;
  document.body.classList.add("chosen");
  Object.assign(selection.style, {
    left: `${rect.x}px`,
    top: `${rect.y}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
  });
  const scale = window.devicePixelRatio || 1;
  size.textContent = `${Math.round(rect.width * scale)} × ${Math.round(rect.height * scale)}`;
}

function place(): void {
  if (!rect) return;
  actions.hidden = false;
  const below = rect.y + rect.height + 12;
  const top =
    below + 40 < window.innerHeight ? below : Math.max(12, rect.y - 52);
  actions.style.top = `${top}px`;
  actions.style.left = `${Math.max(12, Math.min(window.innerWidth - 260, rect.x + rect.width - 250))}px`;
  hint.hidden = true;
  confirm.focus();
}

document.addEventListener("pointerdown", (event) => {
  if (event.button !== 0 || actions.contains(event.target as Node)) return;
  start = { x: event.clientX, y: event.clientY };
  rect = null;
  actions.hidden = true;
  hint.hidden = false;
  document.documentElement.setPointerCapture?.(event.pointerId);
  draw();
});
document.addEventListener("pointermove", (event) => {
  if (!start) return;
  const x = Math.max(0, Math.min(start.x, event.clientX));
  const y = Math.max(0, Math.min(start.y, event.clientY));
  rect = {
    x,
    y,
    width: Math.min(window.innerWidth, Math.max(start.x, event.clientX)) - x,
    height: Math.min(window.innerHeight, Math.max(start.y, event.clientY)) - y,
  };
  draw();
});
document.addEventListener("pointerup", () => {
  if (!start) return;
  start = null;
  if (!rect || rect.width < minimum || rect.height < minimum) rect = null;
  draw();
  place();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") finish(null);
  else if (event.key === "Enter" && rect && !start) {
    event.preventDefault();
    finish(rect);
  }
});
confirm.addEventListener("click", () => finish(rect));
cancel.addEventListener("click", () => finish(null));
window.addEventListener("blur", () => {
  // Losing focus to another window abandons the choice.
  if (!start) finish(null);
});

export {};
