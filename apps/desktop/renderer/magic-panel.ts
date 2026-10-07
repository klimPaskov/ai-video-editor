import type { MagicWandPreset } from "../../../packages/domain/src/magic-wand.ts";
import type { MagicWandView } from "../../../packages/domain/src/magic-wand-view.ts";
import type { ProjectView } from "../../../packages/domain/src/project-view.ts";

const presetNotes: Record<MagicWandPreset, string> = {
  gentle:
    "Shortens only very long pauses and removes earlier repeated takes. Fillers stay.",
  balanced:
    "Shortens long pauses, removes clean um/uh fillers and earlier repeated takes. Protected and uncertain words stay.",
  tight:
    "Also shortens shorter pauses. Names, numbers, negations and uncertain words stay.",
};

function seconds(us: number): string {
  return `${(us / 1_000_000).toFixed(1)} s`;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** The completed run's one-line change summary. */
export function magicSummaryText(view: MagicWandView): string {
  const summary = view.summary;
  if (!summary || summary.cuts === 0) return "";
  const parts = [
    summary.pauses ? plural(summary.pauses, "long pause", "long pauses") : null,
    summary.fillers ? plural(summary.fillers, "filler", "fillers") : null,
    summary.repeatedTakes
      ? plural(summary.repeatedTakes, "repeated take", "repeated takes")
      : null,
  ].filter(Boolean);
  const review = summary.leftForReview
    ? ` ${plural(summary.leftForReview, "item", "items")} left for review.`
    : "";
  return `Removed ${seconds(summary.removedUs)} in ${plural(summary.cuts, "cut", "cuts")}: ${parts.join(", ")}.${review} Undo in Edit reverses each step.`;
}

export interface MagicPanel {
  render(project: ProjectView | undefined, visible: boolean): void;
}

/** Auto Edit's Magic Edit controls: preset, run, live progress, Stop, summary. */
export function setupMagicPanel(onFinished: () => void): MagicPanel {
  const element = <T extends HTMLElement = HTMLElement>(id: string) =>
    document.getElementById(id)! as T;
  const preset = element<HTMLSelectElement>("magic-preset");
  const start = element<HTMLButtonElement>("magic-start");
  const stop = element<HTMLButtonElement>("magic-stop");
  const note = element("magic-note");
  const progress = element<HTMLProgressElement>("magic-progress");
  const status = element("magic-status");
  const errorText = element("magic-error");
  let project: ProjectView | undefined;
  let visible = false;
  let view: MagicWandView | undefined;
  let pending = false;
  let localError: string | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let viewProject: string | undefined;
  let wasRunning = false;

  const request = () => ({
    schema_version: "1.0" as const,
    project_id: project!.id,
  });
  const running = () =>
    view?.status === "transcribing" || view?.status === "applying";

  function paint(): void {
    if (!visible || !project) return;
    const active = running();
    note.textContent = presetNotes[preset.value as MagicWandPreset];
    start.hidden = active;
    start.disabled = pending;
    preset.disabled = pending || active;
    stop.hidden = !active;
    stop.disabled = pending;
    progress.hidden = !active;
    if (active && view?.progress !== null && view?.progress !== undefined)
      progress.value = Math.round(view.progress * 1000);
    const text = active
      ? view?.status === "transcribing"
        ? "Transcribing locally before editing…"
        : "Applying cuts to the draft…"
      : view?.status === "completed" || view?.status === "stopped"
        ? magicSummaryText(view)
        : "";
    status.textContent = text;
    status.hidden = !text;
    const message = localError ?? (!active ? (view?.message ?? null) : null);
    errorText.textContent = message ?? "";
    errorText.hidden = !message;
    if (wasRunning && !active) onFinished();
    wasRunning = active;
  }

  function schedule(): void {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (visible && project && running())
      timer = setTimeout(() => void refresh(), 400);
  }

  async function refresh(): Promise<void> {
    if (!project) return;
    const id = project.id;
    const reply = await window.desktop.getMagicWand(request());
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
        localError = reply.message ?? "Magic Edit could not start.";
      else view = reply.value as MagicWandView;
    } finally {
      pending = false;
      paint();
      schedule();
    }
  }

  preset.addEventListener("change", paint);
  start.addEventListener(
    "click",
    () =>
      void act(() =>
        window.desktop.startMagicWand({
          ...request(),
          preset: preset.value as MagicWandPreset,
        }),
      ),
  );
  stop.addEventListener(
    "click",
    () => void act(() => window.desktop.stopMagicWand(request())),
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
        wasRunning = false;
      }
      if (visible && (changed || !view)) void refresh();
      paint();
      schedule();
    },
  };
}
