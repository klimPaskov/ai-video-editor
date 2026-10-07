import type { ProjectView } from "../../../packages/domain/src/project-view.ts";
import type { ShortClipsView } from "../../../packages/domain/src/short-clips-view.ts";
import type {
  ShortFormat,
  ShortFraming,
} from "../../../packages/domain/src/short-clips.ts";

function element<T extends HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error("Missing control");
  return value as T;
}

function clock(us: number): string {
  const total = Math.round(us / 1_000_000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * Short clips in Export: find self-contained moments in the draft, preview
 * one in the player, discard it or export it as an MP4 for social video.
 */
export function setupShortsPanel(options: {
  preview(startUs: number, endUs: number): void;
}): { render(project: ProjectView | undefined, visible: boolean): void } {
  const find = element<HTMLButtonElement>("shorts-find");
  const format = element<HTMLSelectElement>("shorts-format");
  const framing = element<HTMLSelectElement>("shorts-framing");
  const position = element<HTMLInputElement>("shorts-position");
  const captions = element<HTMLInputElement>("shorts-captions");
  const note = element("shorts-note");
  const list = element("shorts-list");
  const error = element("shorts-error");
  let projectId: string | undefined;
  let view: ShortClipsView | undefined;
  let pending = false;
  let poll: number | undefined;
  let shown = false;
  let renderKey = "";

  function showError(message: string | null): void {
    error.textContent = message ?? "";
    error.hidden = !message;
  }

  function draw(): void {
    position.hidden = framing.value !== "fill";
    find.disabled = pending || !projectId;
    find.textContent =
      view?.status === "none" || !view ? "Find clips" : "Find again";
    const running = view?.job.status === "running";
    note.textContent = !view
      ? ""
      : view.message
        ? view.message
        : view.status === "none"
          ? "Finds self-contained moments of 15 to 60 seconds in the transcript of this edit."
          : `${view.candidates.length} ${view.candidates.length === 1 ? "clip" : "clips"} found from the transcript.`;
    list.replaceChildren(
      ...(view?.status === "ready" ? view.candidates : []).map((candidate) => {
        const item = document.createElement("li");
        item.className = "short-item";
        item.dataset.clipId = candidate.id;
        const head = document.createElement("div");
        head.className = "short-head";
        const title = document.createElement("strong");
        title.textContent = candidate.title;
        const time = document.createElement("span");
        time.className = "short-time";
        time.textContent = `${clock(candidate.startUs)}–${clock(candidate.endUs)} · ${Math.round((candidate.endUs - candidate.startUs) / 1_000_000)} s`;
        head.append(title, time);
        const reasons = document.createElement("div");
        reasons.className = "short-reasons";
        for (const reason of candidate.reasons) {
          const chip = document.createElement("span");
          chip.textContent = reason;
          reasons.append(chip);
        }
        const excerpt = document.createElement("p");
        excerpt.className = "short-excerpt";
        excerpt.textContent = candidate.excerpt;
        const actions = document.createElement("div");
        actions.className = "short-actions";
        const job = view!.job.clipId === candidate.id ? view!.job : null;
        const previewButton = document.createElement("button");
        previewButton.type = "button";
        previewButton.className = "ghost";
        previewButton.dataset.icon = "play";
        previewButton.textContent = "Preview";
        previewButton.setAttribute("aria-label", `Preview ${candidate.title}`);
        previewButton.addEventListener("click", () =>
          options.preview(candidate.startUs, candidate.endUs),
        );
        const discard = document.createElement("button");
        discard.type = "button";
        discard.className = "ghost";
        discard.textContent = "Discard";
        discard.setAttribute("aria-label", `Discard ${candidate.title}`);
        discard.disabled = pending || job?.status === "running";
        discard.addEventListener(
          "click",
          () => void act("discard", candidate.id),
        );
        const exportButton = document.createElement("button");
        exportButton.type = "button";
        exportButton.className = "primary";
        exportButton.dataset.icon = "export";
        exportButton.textContent = "Export clip";
        exportButton.setAttribute("aria-label", `Export ${candidate.title}`);
        exportButton.disabled = pending || running;
        exportButton.addEventListener(
          "click",
          () => void act("export", candidate.id),
        );
        actions.append(previewButton, discard, exportButton);
        item.append(head, reasons, excerpt, actions);
        if (job && job.status !== "idle") {
          const status = document.createElement("div");
          status.className = "short-status";
          status.setAttribute("role", "status");
          if (job.status === "running") {
            const bar = document.createElement("progress");
            bar.max = 1000;
            bar.value = Math.round((job.fraction ?? 0) * 1000);
            bar.setAttribute("aria-label", "Clip export progress");
            const cancel = document.createElement("button");
            cancel.type = "button";
            cancel.textContent = "Cancel";
            cancel.addEventListener(
              "click",
              () => void act("cancel", candidate.id),
            );
            status.append(bar, cancel);
          } else if (job.status === "completed")
            status.textContent = `Saved ${job.fileName}`;
          else if (job.message) status.textContent = job.message;
          if (status.childNodes.length) item.append(status);
        }
        return item;
      }),
    );
  }

  function schedule(): void {
    if (poll !== undefined) window.clearTimeout(poll);
    poll = undefined;
    if (view?.job.status === "running" && shown)
      poll = window.setTimeout(() => void refresh(), 500);
  }

  async function refresh(): Promise<void> {
    const id = projectId;
    if (!id) return;
    const reply = await window.desktop
      .getShortClips({ schema_version: "1.0", project_id: id })
      .catch(() => null);
    if (id !== projectId) return;
    if (reply?.ok) view = reply.value;
    draw();
    schedule();
  }

  async function act(
    action: "find" | "discard" | "export" | "cancel",
    clipId?: string,
  ): Promise<void> {
    const id = projectId;
    if (!id || pending) return;
    pending = true;
    showError(null);
    draw();
    const base = { schema_version: "1.0" as const, project_id: id };
    const reply = await (
      action === "find"
        ? window.desktop.findShortClips(base)
        : action === "cancel"
          ? window.desktop.cancelShortClip(base)
          : action === "discard"
            ? window.desktop.discardShortClip({ ...base, clip_id: clipId! })
            : window.desktop.exportShortClip({
                ...base,
                clip_id: clipId!,
                format: format.value as ShortFormat,
                framing: framing.value as ShortFraming,
                position: Number(position.value) / 100,
                captions: captions.checked,
              })
    ).catch(() => null);
    pending = false;
    if (id !== projectId) return;
    if (reply?.ok) view = reply.value;
    else
      showError(
        reply && !reply.ok ? reply.message : "Short clips did not respond.",
      );
    draw();
    schedule();
  }

  find.addEventListener("click", () => void act("find"));
  framing.addEventListener("change", draw);

  return {
    render(project, visible) {
      shown = visible;
      if (project?.id !== projectId) {
        projectId = project?.id;
        view = undefined;
        showError(null);
      }
      // Refresh when the panel appears or the draft changes, not every render.
      const key = `${projectId}:${project?.draft.sequence}:${visible}`;
      if (key === renderKey) return;
      renderKey = key;
      if (visible && projectId) void refresh();
      else schedule();
    },
  };
}
