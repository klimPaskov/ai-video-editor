import type { MagicWandPreset } from "../../../packages/domain/src/magic-wand.ts";
import type {
  MagicWandProvider,
  MagicWandView,
} from "../../../packages/domain/src/magic-wand-view.ts";
import type { ProjectView } from "../../../packages/domain/src/project-view.ts";

const presetNotes: Record<MagicWandPreset, string> = {
  gentle:
    "Shortens only long pauses to about half a second and removes clear fillers, then the assistant removes clear retakes and dead air.",
  balanced:
    "Shortens pauses over half a second to a short beat and removes fillers, then the assistant makes a story edit.",
  tight:
    "Keeps only a hint of a pause and removes fillers, then the assistant makes a brisk story edit.",
};

export const providerNames: Record<MagicWandProvider, string> = {
  claude: "Claude",
  codex: "Codex",
  deepseek: "DeepSeek",
  openai: "OpenAI API",
  gemini: "Gemini API",
};

/** The one line under the preset: what it does and who makes the story edit. */
export function magicNoteText(
  preset: MagicWandPreset,
  provider: MagicWandProvider,
): string {
  const paid =
    provider === "deepseek" || provider === "openai" || provider === "gemini";
  return `${presetNotes[preset]} The story edit uses ${providerNames[provider]}${provider === "claude" ? ", which gives the best results" : ""}${paid ? " and is billed to your API account" : ""}. Choose another in the assistant drawer.`;
}

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
  // Claude's rough cut explains itself in the conversation.
  const detail = parts.length ? `: ${parts.join(", ")}` : "";
  return `Removed ${seconds(summary.removedUs)} in ${plural(summary.cuts, "cut", "cuts")}${detail}.${review} Undo in Edit reverses each step.`;
}

export interface MagicPanel {
  render(project: ProjectView | undefined, visible: boolean): void;
}

/** Auto Edit's Magic Edit controls: preset, run, live progress, Stop, summary. */
export function setupMagicPanel(
  onFinished: () => void,
  provider: () => MagicWandProvider = () => "claude",
): MagicPanel {
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
    note.textContent = magicNoteText(
      preset.value as MagicWandPreset,
      provider(),
    );
    start.hidden = active;
    start.disabled = pending;
    preset.disabled = pending || active;
    stop.hidden = !active;
    stop.disabled = pending;
    progress.hidden = !active;
    if (active && view?.progress !== null && view?.progress !== undefined)
      progress.value = Math.round(view.progress * 1000);
    // Claude's edit has no measurable progress: an open-ended bar.
    else if (active) progress.removeAttribute("value");
    const text = active
      ? view?.status === "transcribing"
        ? "Transcribing locally before editing…"
        : `${providerNames[provider()]} is making the rough cut…`
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
    // While idle the panel still looks now and then: the assistant can
    // start Magic Edit from a chat (ADR 0030) and the card should show it.
    if (visible && project)
      timer = setTimeout(() => void refresh(), running() ? 400 : 1500);
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
          provider: provider(),
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
