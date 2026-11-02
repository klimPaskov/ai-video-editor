import type { ProjectView } from "../../../packages/domain/src/project-view.ts";
import type { ShortClipsView } from "../../../packages/domain/src/short-clips-view.ts";
import type {
  ShortFormat,
  ShortFraming,
  ShortSpeed,
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
  /** A small picture of the edit at this time, or null. */
  picture(timeUs: number): Promise<HTMLCanvasElement | null>;
  /** How many clips are saved, so the step can offer to go on. */
  saved(count: number): void;
}): { render(project: ProjectView | undefined, visible: boolean): void } {
  const find = element<HTMLButtonElement>("shorts-find");
  const pick = element<HTMLButtonElement>("shorts-pick");
  const exportAll = element<HTMLButtonElement>("shorts-export-all");
  const titleSwitch = element<HTMLInputElement>("shorts-title");
  const speed = element<HTMLSelectElement>("shorts-speed");
  const batch = element("shorts-batch");
  const libraryBox = element("shorts-library-box");
  const library = element("shorts-library");
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
  /** The clips the user wants made; new clips start chosen. */
  const chosen = new Set<string>();
  const seen = new Set<string>();

  function showError(message: string | null): void {
    error.textContent = message ?? "";
    error.hidden = !message;
  }

  function exportOptions() {
    return {
      format: format.value as ShortFormat,
      framing: framing.value as ShortFraming,
      position: Number(position.value) / 100,
      captions: captions.checked,
      title: titleSwitch.checked,
      speed: Number(speed.value) as ShortSpeed,
    };
  }

  function draw(): void {
    position.hidden = framing.value !== "fill";
    const picking = view?.pick.running === true;
    find.disabled = pending || !projectId || picking;
    pick.disabled = pending || !projectId || picking;
    pick.textContent = picking ? "Claude is choosing…" : "Pick with Claude";
    // Until clips exist the step's one button finds them; this one only
    // appears to look again.
    find.hidden = view?.status !== "ready" || view.candidates.length === 0;
    find.textContent = "Find again";
    const running = view?.job.status === "running";
    const shown = view?.status === "ready" ? view.candidates : [];
    for (const candidate of shown)
      if (!seen.has(candidate.id)) {
        seen.add(candidate.id);
        chosen.add(candidate.id);
      }
    const count = shown.filter((candidate) => chosen.has(candidate.id)).length;
    // The step's one button always has something to do: find clips first, then
    // make the chosen ones.
    exportAll.textContent =
      shown.length === 0
        ? "Find clips"
        : count === 0
          ? "Choose a clip"
          : `Make ${count === 1 ? "1 clip" : `${count} clips`}`;
    exportAll.disabled =
      pending ||
      running ||
      picking ||
      (shown.length > 0 && count === 0) ||
      !projectId;
    options.saved(view?.library.length ?? 0);
    note.textContent = !view
      ? ""
      : picking
        ? "Claude is reading the edit and choosing clips. This can take a minute."
        : (view.pick.message ??
          view.message ??
          (view.status === "none"
            ? "Finds 15 to 60 second moments, or lets Claude choose."
            : `${view.candidates.length} ${view.candidates.length === 1 ? "clip" : "clips"} ${view.candidates.every((candidate) => candidate.origin === "ai") ? "chosen by Claude" : "found from the transcript"}.`));
    // One status for exporting every clip: which one, and progress.
    const job = view?.job;
    batch.hidden = !(job?.batch && job.status !== "idle");
    batch.replaceChildren();
    if (job?.batch && job.status !== "idle") {
      if (job.status === "running") {
        const text = document.createElement("span");
        text.textContent = `Exporting clip ${job.batch.index + 1} of ${job.batch.total}${job.fileName ? `: ${job.fileName}` : ""}`;
        const bar = document.createElement("progress");
        bar.max = 1000;
        bar.value = Math.round((job.fraction ?? 0) * 1000);
        bar.setAttribute("aria-label", "Clip export progress");
        const cancel = document.createElement("button");
        cancel.type = "button";
        cancel.textContent = "Cancel";
        cancel.addEventListener("click", () => void act("cancel"));
        batch.append(text, bar, cancel);
      } else
        batch.textContent =
          job.status === "completed"
            ? `Saved ${job.batch.total} ${job.batch.total === 1 ? "clip" : "clips"}.`
            : (job.message ?? "");
    }
    // The clips exported from this project, newest first.
    libraryBox.hidden = !view || view.library.length === 0;
    library.replaceChildren(
      ...(view?.library ?? []).map((saved) => {
        const item = document.createElement("li");
        item.className = "short-saved";
        item.dataset.exportId = saved.id;
        const name = document.createElement("strong");
        name.textContent = saved.fileName;
        const meta = document.createElement("span");
        meta.className = "short-time";
        meta.textContent = `${{ vertical: "9:16", square: "1:1", landscape: "16:9" }[saved.format]} · ${clock(saved.durationUs)}${saved.speed === 2 ? " · 2×" : ""}${saved.exists ? "" : " · file moved or deleted"}`;
        const show = document.createElement("button");
        show.type = "button";
        show.className = "ghost";
        show.textContent = "Show in folder";
        show.setAttribute("aria-label", `Show ${saved.fileName} in its folder`);
        show.disabled = pending || !saved.exists;
        show.addEventListener(
          "click",
          () => void act("reveal", undefined, saved.id),
        );
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "ghost";
        remove.textContent = "Remove from list";
        remove.setAttribute(
          "aria-label",
          `Remove ${saved.fileName} from the list`,
        );
        remove.disabled = pending;
        remove.addEventListener(
          "click",
          () => void act("forget", undefined, saved.id),
        );
        item.append(name, meta, show, remove);
        return item;
      }),
    );
    list.replaceChildren(
      ...(view?.status === "ready" ? view.candidates : []).map((candidate) => {
        const item = document.createElement("li");
        item.className = "short-item";
        item.dataset.clipId = candidate.id;
        item.classList.toggle("chosen", chosen.has(candidate.id));
        const job = view!.job.clipId === candidate.id ? view!.job : null;
        const seconds = Math.round((candidate.endUs - candidate.startUs) / 1e6);
        // The picture, with Preview over it and the choice in its corner.
        const picture = document.createElement("div");
        picture.className = "short-picture";
        void options.picture(candidate.startUs + 200_000).then((canvas) => {
          if (canvas) picture.prepend(canvas);
        });
        const check = document.createElement("input");
        check.type = "checkbox";
        check.className = "short-check";
        check.checked = chosen.has(candidate.id);
        check.setAttribute("aria-label", `Choose ${candidate.title}`);
        check.addEventListener("change", () => {
          if (check.checked) chosen.add(candidate.id);
          else chosen.delete(candidate.id);
          draw();
        });
        const previewButton = document.createElement("button");
        previewButton.type = "button";
        previewButton.className = "short-preview";
        previewButton.dataset.icon = "play";
        previewButton.textContent = `${clock(candidate.startUs)}–${clock(candidate.endUs)}`;
        previewButton.setAttribute("aria-label", `Preview ${candidate.title}`);
        previewButton.addEventListener("click", () =>
          options.preview(candidate.startUs, candidate.endUs),
        );
        picture.append(check, previewButton);
        // Name and length on one line; Claude's pick is marked.
        const foot = document.createElement("div");
        foot.className = "short-foot";
        const title = document.createElement("strong");
        title.textContent = candidate.title;
        const time = document.createElement("span");
        time.className = "short-time";
        time.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
        foot.append(title, time);
        const actions = document.createElement("div");
        actions.className = "short-actions";
        if (candidate.origin === "ai") {
          const chip = document.createElement("span");
          chip.className = "short-origin";
          chip.textContent = "Claude's pick";
          actions.append(chip);
        }
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
        exportButton.className = "ghost";
        exportButton.textContent = "Save only this";
        exportButton.setAttribute("aria-label", `Export ${candidate.title}`);
        exportButton.disabled = pending || running;
        exportButton.addEventListener(
          "click",
          () => void act("export", candidate.id),
        );
        actions.append(discard, exportButton);
        item.append(picture, foot, actions);
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
    if ((view?.job.status === "running" || view?.pick.running) && shown)
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
    action:
      | "find"
      | "pick"
      | "discard"
      | "export"
      | "exportAll"
      | "cancel"
      | "reveal"
      | "forget",
    clipId?: string,
    exportId?: string,
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
        : action === "pick"
          ? window.desktop.pickShortClips(base)
          : action === "cancel"
            ? window.desktop.cancelShortClip(base)
            : action === "discard"
              ? window.desktop.discardShortClip({ ...base, clip_id: clipId! })
              : action === "exportAll"
                ? window.desktop.exportAllShortClips({
                    ...base,
                    ...exportOptions(),
                    clip_ids: (view?.status === "ready" ? view.candidates : [])
                      .filter((candidate) => chosen.has(candidate.id))
                      .map((candidate) => candidate.id),
                  })
                : action === "reveal"
                  ? window.desktop.revealShortClip({
                      ...base,
                      export_id: exportId!,
                    })
                  : action === "forget"
                    ? window.desktop.forgetShortClip({
                        ...base,
                        export_id: exportId!,
                      })
                    : window.desktop.exportShortClip({
                        ...base,
                        clip_id: clipId!,
                        ...exportOptions(),
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
  pick.addEventListener("click", () => void act("pick"));
  exportAll.addEventListener(
    "click",
    () => void act(view?.status === "ready" ? "exportAll" : "find"),
  );
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
