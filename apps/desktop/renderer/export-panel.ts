import type {
  ExportProfileChoice,
  ExportView,
} from "../../../packages/domain/src/export-view.ts";
import type { ProjectView } from "../../../packages/domain/src/project-view.ts";

const profileNotes: Record<ExportProfileChoice, string> = {
  lossless_master:
    "Matroska with FFV1 video and PCM audio. Every edited frame and audio sample is kept exactly; files are large.",
  smaller_mp4:
    "Compressed H.264/AAC copy for sharing. Some detail is lost; the lossless master is not affected.",
};

function size(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function clock(us: number): string {
  const total = Math.round(us / 1000);
  const minutes = Math.floor(total / 60000);
  const seconds = ((total % 60000) / 1000).toFixed(1).padStart(4, "0");
  return `${minutes}:${seconds}`;
}

export interface ExportPanel {
  /** Re-renders for the current project and visibility. */
  render(project: ProjectView | undefined, visible: boolean): void;
}

/** Export step: one quality choice, a save dialog in main, verified result. */
export function setupExportPanel(): ExportPanel {
  const element = <T extends HTMLElement = HTMLElement>(id: string) =>
    document.getElementById(id)! as T;
  const panel = element("export-actions");
  const profileSelect = element<HTMLSelectElement>("export-profile");
  const note = element("export-profile-note");
  const startButton = element<HTMLButtonElement>("export-start");
  const running = element("export-running");
  const progress = element<HTMLProgressElement>("export-progress");
  const phase = element("export-phase");
  const cancelButton = element<HTMLButtonElement>("export-cancel");
  const done = element("export-done");
  const result = element("export-result");
  const errorText = element("export-error");
  let project: ProjectView | undefined;
  let visible = false;
  let view: ExportView | undefined;
  let pending = false;
  let localError: string | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let viewProject: string | undefined;

  const request = () => ({
    schema_version: "1.0" as const,
    project_id: project!.id,
  });

  function paint(): void {
    panel.hidden = !visible;
    if (!visible || !project) return;
    const state = view?.status ?? "idle";
    const active = state === "running" || state === "cancelling";
    element("export-setup").hidden = active || state === "completed";
    running.hidden = !active;
    done.hidden = state !== "completed";
    note.textContent = profileNotes[profileSelect.value as ExportProfileChoice];
    startButton.disabled = pending;
    profileSelect.disabled = pending;
    if (active && view?.fraction !== null && view?.fraction !== undefined)
      progress.value = Math.round(view.fraction * 1000);
    phase.textContent =
      state === "cancelling"
        ? "Cancelling…"
        : view?.phase === "verifying"
          ? "Verifying the exported file…"
          : "Rendering…";
    cancelButton.disabled = pending || state === "cancelling";
    if (state === "completed" && view?.result) {
      const exported = view.result;
      result.textContent = `${exported.fileName} · ${clock(exported.durationUs)} · ${size(exported.outputBytes)}${
        exported.profile === "lossless_master" ? " · verified lossless" : ""
      }`;
    }
    const message =
      localError ??
      (state === "failed" || state === "completed"
        ? (view?.message ?? null)
        : null);
    errorText.textContent = message ?? "";
    errorText.hidden = !message;
  }

  function schedule(): void {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (!visible || !project) return;
    if (view?.status === "running" || view?.status === "cancelling")
      timer = setTimeout(() => void refresh(), 400);
  }

  async function refresh(): Promise<void> {
    if (!visible || !project) return;
    const id = project.id;
    const reply = await window.desktop.getExport(request());
    if (project?.id !== id) return;
    if (reply.ok) view = reply.value;
    paint();
    schedule();
  }

  async function act(
    work: () => Promise<{ ok: boolean; value?: unknown; message?: string }>,
  ): Promise<void> {
    if (pending || !project) return;
    pending = true;
    localError = null;
    paint();
    try {
      const reply = await work();
      if (!reply.ok)
        localError = reply.message ?? "The export could not start.";
      else if (reply.value && typeof reply.value === "object")
        view = reply.value as ExportView;
    } finally {
      pending = false;
      paint();
      schedule();
    }
  }

  profileSelect.addEventListener("change", paint);
  startButton.addEventListener(
    "click",
    () =>
      void act(() =>
        window.desktop.startExport({
          ...request(),
          profile: profileSelect.value as ExportProfileChoice,
        }),
      ),
  );
  cancelButton.addEventListener(
    "click",
    () => void act(() => window.desktop.cancelExport(request())),
  );
  element("export-again").addEventListener(
    "click",
    () => void act(() => window.desktop.resetExport(request())),
  );
  element("export-open").addEventListener(
    "click",
    () => void act(() => window.desktop.openExport(request())),
  );
  element("export-reveal").addEventListener(
    "click",
    () => void act(() => window.desktop.revealExport(request())),
  );

  return {
    render(next, show) {
      const changed = next?.id !== viewProject;
      project = next;
      visible = show && !!next;
      if (changed) {
        viewProject = next?.id;
        view = undefined;
        localError = null;
        if (visible) void refresh();
      } else if (visible && !view) void refresh();
      paint();
      schedule();
    },
  };
}
