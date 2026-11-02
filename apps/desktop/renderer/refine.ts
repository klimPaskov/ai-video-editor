import type {
  EditSummaryKind,
  EditSummaryView,
} from "../../../packages/domain/src/edit-summary.ts";
import type {
  ProjectDraftView,
  ProjectView,
} from "../../../packages/domain/src/project-view.ts";
import type { Reply } from "../src/bridge.ts";

const kindIcons: Record<EditSummaryKind, string> = {
  cuts: "scissors",
  zooms: "zoom",
  graphics: "image",
  captions: "captions",
  music: "music",
  effects: "music",
  speed: "speed",
  transitions: "transition",
  camera: "video",
  sound: "volume",
};

function element<T extends HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error("Missing control");
  return value as T;
}

/**
 * Refine's "What Magic Edit did" list (ADR 0031). Main builds the rows from
 * the draft's own transaction records. A row's Undo removes that whole kind of
 * change as ordinary history (the shared Undo still works), and the row then
 * offers Put back. Nothing here changes the draft itself.
 */
export function setupDidList(options: {
  /** Shows a draft that main committed. */
  apply(reply: Reply<ProjectDraftView>): void;
  /** Another edit is being saved; the list waits. */
  busy(): boolean;
  fail(message: string): void;
}): { render(project: ProjectView | undefined, visible: boolean): void } {
  const card = element("did-card");
  const list = element("did-list");
  const empty = element("did-empty");
  let projectId: string | undefined;
  let key = "";
  let view: EditSummaryView | undefined;
  let pending = false;
  let generation = 0;

  const request = () => ({
    schema_version: "1.0" as const,
    project_id: projectId!,
  });

  function draw(): void {
    const rows = view?.rows ?? [];
    const putBack = view?.putBack ?? null;
    empty.hidden = rows.length > 0 || putBack !== null || view === undefined;
    const items: HTMLElement[] = [];
    if (putBack) {
      const item = document.createElement("li");
      item.className = "did-row did-undone";
      const label = document.createElement("span");
      label.className = "did-label";
      label.textContent = putBack.label;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "ghost did-action";
      button.textContent = "Put back";
      button.setAttribute("aria-label", `Put back: ${putBack.label}`);
      button.disabled = pending || options.busy();
      button.addEventListener("click", () => void act("putBack"));
      item.append(iconCell("restore"), label, button);
      items.push(item);
    }
    for (const row of rows) {
      const item = document.createElement("li");
      item.className = "did-row";
      item.dataset.kind = row.kind;
      const label = document.createElement("span");
      label.className = "did-label";
      label.textContent = row.label;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "ghost did-action";
      button.textContent = "Undo";
      button.title = `Undo all of this: ${row.label.toLowerCase()}`;
      button.setAttribute("aria-label", `Undo: ${row.label}`);
      button.disabled = pending || options.busy();
      button.addEventListener("click", () => void act("undo", row.kind));
      item.append(iconCell(kindIcons[row.kind]), label, button);
      items.push(item);
    }
    list.replaceChildren(...items);
  }

  function iconCell(name: string): HTMLElement {
    const cell = document.createElement("span");
    cell.className = "did-icon";
    cell.dataset.icon = name;
    return cell;
  }

  async function load(): Promise<void> {
    const id = projectId;
    if (!id) return;
    const attempt = ++generation;
    const reply = await window.desktop
      .getEditSummary({ schema_version: "1.0", project_id: id })
      .catch(() => null);
    if (attempt !== generation || id !== projectId) return;
    if (reply?.ok) view = reply.value;
    draw();
  }

  async function act(
    what: "undo" | "putBack",
    kind?: EditSummaryKind,
  ): Promise<void> {
    if (!projectId || pending || options.busy()) return;
    pending = true;
    draw();
    try {
      const reply =
        what === "putBack"
          ? await window.desktop.putBackEditSummary(request())
          : await window.desktop.undoEditSummary({ ...request(), kind: kind! });
      // A refusal reaches the person through the same error line as any edit.
      options.apply(reply);
    } catch {
      options.fail("The change could not be undone. Try again.");
    } finally {
      pending = false;
      key = "";
      await load();
    }
  }

  return {
    render(project, visible) {
      card.hidden = !visible || !project;
      if (!visible || !project) return;
      if (project.id !== projectId) {
        projectId = project.id;
        view = undefined;
        key = "";
        list.replaceChildren();
      }
      const next = `${project.id}:${project.draft.sequence}:${project.draft.timelineSha256}`;
      if (next === key) return;
      key = next;
      void load();
    },
  };
}

/**
 * Pop-overs of Refine's tools: one open at a time, closed by a click
 * elsewhere or Esc, which returns focus to the tool.
 */
export function setupToolPopovers(): { closeAll(): void } {
  const pairs = ["rt-trim", "rt-captions", "rt-music", "rt-volume"].map(
    (id) => ({
      button: element<HTMLButtonElement>(id),
      pop: element(`${id}-pop`),
    }),
  );
  function close(except?: HTMLElement): void {
    for (const { button, pop } of pairs) {
      if (pop === except) continue;
      pop.hidden = true;
      button.setAttribute("aria-expanded", "false");
    }
  }
  for (const { button, pop } of pairs)
    button.addEventListener("click", () => {
      if (button.getAttribute("aria-disabled") === "true") return;
      const open = pop.hidden;
      close(pop);
      pop.hidden = !open;
      button.setAttribute("aria-expanded", String(open));
    });
  document.addEventListener("click", (event) => {
    const target = event.target as Node | null;
    if (
      target &&
      !pairs.some(
        ({ button, pop }) => button.contains(target) || pop.contains(target),
      )
    )
      close();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    const open = pairs.find(({ pop }) => !pop.hidden);
    if (!open) return;
    event.preventDefault();
    close();
    open.button.focus();
  });
  return { closeAll: () => close() };
}
