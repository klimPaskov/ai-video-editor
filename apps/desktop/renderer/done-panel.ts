import type {
  ExportResultView,
  ExportView,
} from "../../../packages/domain/src/export-view.ts";
import type { ProjectView } from "../../../packages/domain/src/project-view.ts";

function element<T extends HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error("Missing control");
  return value as T;
}

function size(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function length(us: number): string {
  const total = Math.round(us / 1_000_000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
    : `${minutes}:${seconds}`;
}

/** The line under the file name: length, size and where it was saved. */
export function doneMeta(result: ExportResultView): string {
  return `${length(result.durationUs)} · ${size(result.outputBytes)} · saved to ${result.folderName}`;
}

/**
 * The Done screen after a finished export (ADR 0031). Every button acts on
 * real state: the same main handlers that show the file in its folder and open
 * it, and navigation. Nothing here exports or deletes anything.
 */
export function setupDonePanel(options: {
  /** The picture of the project, as on its card. */
  thumbnail(mediaId: string, name: string): HTMLElement;
  goTo(stage: "clips" | "export"): void;
  home(): void;
  importAnother(): void;
}): { render(project: ProjectView | undefined, visible: boolean): void } {
  const panel = element("done-actions");
  const picture = element("done-thumb");
  const name = element("done-name");
  const meta = element("done-meta");
  const clipsCard = element<HTMLButtonElement>("done-clips");
  const errorText = element("done-error");
  let project: ProjectView | undefined;
  let visible = false;
  let shownFor: string | undefined;
  let loadingFor: string | undefined;
  let generation = 0;

  const request = () => ({
    schema_version: "1.0" as const,
    project_id: project!.id,
  });

  function fail(message: string | null): void {
    errorText.textContent = message ?? "";
    errorText.hidden = !message;
  }

  async function act(
    work: () => Promise<{ ok: boolean; message?: string }>,
  ): Promise<void> {
    if (!project) return;
    fail(null);
    try {
      const reply = await work();
      if (!reply.ok)
        fail(reply.message ?? "That did not work. Try again from Export.");
    } catch {
      fail("That did not work. Try again from Export.");
    }
  }

  async function load(): Promise<void> {
    const current = project;
    if (!current) return;
    const attempt = ++generation;
    loadingFor = current.id;
    const [exported, clips] = await Promise.all([
      window.desktop.getExport(request()).catch(() => null),
      window.desktop.getShortClips(request()).catch(() => null),
    ]);
    if (attempt !== generation || project?.id !== current.id || !visible)
      return;
    loadingFor = undefined;
    const view: ExportView | undefined = exported?.ok
      ? exported.value
      : undefined;
    if (!view || view.status !== "completed" || !view.result) {
      // After a restart nothing here describes the file: Export is where to
      // look at it again.
      options.goTo("export");
      return;
    }
    shownFor = current.id;
    name.textContent = view.result.fileName;
    meta.textContent = doneMeta(view.result);
    picture.replaceChildren(options.thumbnail(current.source.id, current.name));
    // Make short clips is offered while no clip has been made.
    clipsCard.hidden = clips?.ok === true && clips.value.library.length > 0;
  }

  element("done-reveal").addEventListener(
    "click",
    () => void act(() => window.desktop.revealExport(request())),
  );
  element("done-play").addEventListener(
    "click",
    () => void act(() => window.desktop.openExport(request())),
  );
  clipsCard.addEventListener("click", () => options.goTo("clips"));
  element("done-another").addEventListener("click", () =>
    options.importAnother(),
  );
  element("done-home").addEventListener("click", () => options.home());
  element("done-keep").addEventListener("click", () => options.goTo("export"));

  return {
    render(next, show) {
      project = next;
      visible = show && !!next;
      panel.hidden = !visible;
      if (!visible) {
        shownFor = undefined;
        loadingFor = undefined;
        generation++;
        return;
      }
      if (shownFor !== next!.id && loadingFor !== next!.id) void load();
    },
  };
}
