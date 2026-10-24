import type { MagicWandView } from "../../../packages/domain/src/magic-wand-view.ts";
import type { ClaudeThreadView } from "../../../packages/domain/src/claude-view.ts";
import type { ProjectView } from "../../../packages/domain/src/project-view.ts";

type Phase = "idle" | "rough" | "production" | "done" | "stopped" | "failed";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Auto Edit's one action: "Edit my video" runs the whole AI edit the user
 * would otherwise start in two places. First Claude's rough cut (Magic Edit,
 * which transcribes locally first), then Claude's full edit with motion
 * graphics, captions and audio choices. Both are the same guarded, undoable
 * edits as when started by hand; this panel only starts them in order,
 * shows one line of progress and a Stop that reaches whichever is running.
 * The user starts it explicitly, which also starts the production turns of
 * their Claude account.
 */
export function setupAutoPanel(options: {
  /** The rough cut finished: reload the transcript and draft. */
  onFinished(): void;
  /** Open the Review step. */
  review(): void;
  /** The rough-cut preset chosen under More options. */
  presetValue(): "gentle" | "balanced" | "tight";
}): {
  render(project: ProjectView | undefined, visible: boolean): void;
} {
  const element = <T extends HTMLElement = HTMLElement>(id: string) =>
    document.getElementById(id)! as T;
  const start = element<HTMLButtonElement>("auto-all-start");
  const stop = element<HTMLButtonElement>("auto-all-stop");
  const review = element<HTMLButtonElement>("auto-all-review");
  const progress = element<HTMLProgressElement>("auto-all-progress");
  const status = element("auto-all-status");
  const errorText = element("auto-all-error");
  let project: ProjectView | undefined;
  let visible = false;
  let phase: Phase = "idle";
  let detail = "";
  let message: string | null = null;
  let stopRequested = false;
  let runProject: string | undefined;

  const request = (id: string) => ({
    schema_version: "1.0" as const,
    project_id: id,
  });
  const running = () => phase === "rough" || phase === "production";

  function paint(): void {
    if (!visible || !project) return;
    start.hidden = running() || phase === "done";
    start.disabled = !project || running();
    start.textContent =
      phase === "stopped" || phase === "failed" ? "Try again" : "Edit my video";
    stop.hidden = !running();
    stop.disabled = stopRequested;
    review.hidden = phase !== "done";
    progress.hidden = !running();
    const text = running()
      ? `${phase === "rough" ? "Step 1 of 2: rough cut" : "Step 2 of 2: graphics, captions and sound"}${detail ? ` · ${detail}` : ""}`
      : phase === "done"
        ? "Your video is edited. Review it, or undo any step in Edit."
        : phase === "stopped"
          ? "Stopped. What was already done stays in the edit and can be undone."
          : "";
    status.textContent = text;
    status.hidden = !text;
    errorText.textContent = message ?? "";
    errorText.hidden = !message;
  }

  function fail(text: string): void {
    phase = "failed";
    message = text;
    detail = "";
    paint();
  }

  async function roughCut(id: string): Promise<boolean> {
    const first = await window.desktop.startMagicWand({
      ...request(id),
      preset: options.presetValue(),
    });
    if (!first.ok) {
      fail(first.message);
      return false;
    }
    for (;;) {
      if (runProject !== id) return false;
      const reply = await window.desktop.getMagicWand(request(id));
      if (reply.ok) {
        const view: MagicWandView = reply.value;
        if (view.status === "transcribing") detail = "listening to the speech";
        else if (view.status === "applying") detail = "Claude is cutting";
        else {
          if (view.status === "completed") return true;
          if (stopRequested || view.status === "stopped") {
            phase = "stopped";
            paint();
          } else fail(view.message ?? "The rough cut could not finish.");
          return false;
        }
        paint();
      }
      await wait(500);
    }
  }

  async function production(id: string): Promise<void> {
    let thread = await window.desktop.getClaudeThread(request(id));
    if (thread.ok && thread.value.status === "closed")
      thread = await window.desktop.openClaudeThread(request(id));
    if (!thread.ok) return fail(thread.message);
    const begun = await window.desktop.startClaudeFullEdit({
      ...request(id),
      brief: { goal: "", audience: "", style: "", level: "polished" },
    });
    if (!begun.ok) return fail(begun.message);
    for (;;) {
      if (runProject !== id) return;
      const reply = await window.desktop.getClaudeThread(request(id));
      if (reply.ok) {
        const view: ClaudeThreadView = reply.value;
        const active = view.activities.findLast((item) => !item.complete);
        detail = active?.label.toLowerCase() ?? "";
        if (view.status === "ready" || view.status === "failed") {
          const result = view.fullEdit?.status;
          if (stopRequested || result === "stopped") phase = "stopped";
          else if (result === "finished") phase = "done";
          else
            return fail(
              view.message ?? "Claude could not finish the edit. Try again.",
            );
          detail = "";
          paint();
          options.onFinished();
          return;
        }
        paint();
      }
      await wait(1000);
    }
  }

  /** Claude must be ready before anything starts, so nothing is wasted. */
  async function claudeReady(): Promise<string | null> {
    const reply = await window.desktop.getClaude().catch(() => null);
    if (!reply?.ok) return "Claude's status could not be read. Try again.";
    const view = reply.value;
    if (view.status === "signed_in") return null;
    if (view.status === "signed_out")
      return "Sign in with your Claude account in Settings, then try again.";
    if (view.status === "unavailable")
      return (
        view.message ??
        "Claude Code is not installed. Open Settings > Claude to set it up."
      );
    if (view.status === "signing_in")
      return "Finish signing in to Claude, then try again.";
    return view.message ?? "Claude is not ready yet. Try again in a moment.";
  }

  async function run(): Promise<void> {
    if (!project || running()) return;
    const id = project.id;
    const blocked = await claudeReady();
    if (blocked) return fail(blocked);
    runProject = id;
    stopRequested = false;
    message = null;
    detail = "";
    phase = "rough";
    paint();
    try {
      if (!(await roughCut(id))) return;
      options.onFinished();
      if (stopRequested) {
        phase = "stopped";
        paint();
        return;
      }
      phase = "production";
      detail = "";
      paint();
      await production(id);
    } catch {
      fail("The edit could not finish. Try again.");
    }
  }

  start.addEventListener("click", () => void run());
  review.addEventListener("click", () => options.review());
  stop.addEventListener("click", () => {
    const id = runProject;
    if (!id || !running()) return;
    stopRequested = true;
    paint();
    if (phase === "rough")
      void window.desktop.stopMagicWand(request(id)).catch(() => undefined);
    else
      void window.desktop
        .interruptClaudeThread(request(id))
        .catch(() => undefined);
  });

  return {
    render(next, show) {
      if (next?.id !== project?.id && !running()) {
        phase = "idle";
        message = null;
        detail = "";
      }
      project = next;
      visible = show && !!next;
      paint();
    },
  };
}
