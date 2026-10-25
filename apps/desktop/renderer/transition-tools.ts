import type {
  ProjectDraftView,
  ProjectView,
} from "../../../packages/domain/src/project-view.ts";
import {
  nearestCut,
  transitionKinds,
  type TransitionCut,
  type TransitionEffect,
  type TransitionKind,
} from "../../../packages/domain/src/transitions.ts";
import type { Reply } from "../src/bridge.ts";

/**
 * Manual transitions in the Edit step's More tools. The control acts on the
 * cut nearest the playhead: with a style and a length chosen it adds a
 * transition there, changes the one it has, or removes it. Nothing is
 * stored in the page; main anchors the transition to the cut.
 */
export interface TransitionToolsContext {
  add: HTMLButtonElement;
  remove: HTMLButtonElement;
  kind: HTMLSelectElement;
  length: HTMLSelectElement;
  /** Output position of the playhead. */
  position(): number;
  busy(): boolean;
  time(us: number): string;
  /**
   * Runs one manual edit like the other Edit tools do: busy state, the
   * reply applied to the project, a plain message when it cannot be saved.
   * `seekUs` is where the player moves afterwards.
   */
  run(
    work: (project: ProjectView) => Promise<Reply<ProjectDraftView>>,
    failure: string,
    seekUs: number,
  ): Promise<void>;
}

function parseChoice(value: string): { kind: TransitionKind; color: string } {
  const [kind, color] = value.split(":");
  return {
    kind: transitionKinds.includes(kind as TransitionKind)
      ? (kind as TransitionKind)
      : "dip",
    color: /^#[0-9a-fA-F]{6}$/u.test(color ?? "") ? color! : "#000000",
  };
}

export function setupTransitionTools(context: TransitionToolsContext): {
  render(project: ProjectView): void;
} {
  const { add, remove, kind, length } = context;
  let project: ProjectView | undefined;

  function target(): {
    cut: TransitionCut;
    existing: TransitionEffect | undefined;
  } | null {
    if (!project?.clips) return null;
    const cut = nearestCut(project.clips, context.position());
    if (!cut) return null;
    return {
      cut,
      existing: project.transitions?.find(
        (item) =>
          item.source_id === cut.sourceId && item.source_us === cut.sourceUs,
      ),
    };
  }

  function render(next: ProjectView): void {
    project = next;
    const found = target();
    const busy = context.busy();
    add.disabled = busy || !found;
    kind.disabled = busy || !found;
    length.disabled = busy || !found;
    remove.hidden = !found?.existing;
    remove.disabled = busy;
    if (!found) {
      add.textContent = "Add transition";
      add.title = "A transition needs a cut: cut or split a range first";
      add.setAttribute("aria-label", "Add transition (there is no cut yet)");
      return;
    }
    const at = context.time(found.cut.atUs);
    if (found.existing) {
      const { existing } = found;
      const wanted = `${existing.kind}:${existing.color}`;
      const style =
        [...kind.options].find((option) => option.value === wanted) ??
        [...kind.options].find((option) =>
          option.value.startsWith(`${existing.kind}:`),
        );
      if (style) kind.value = style.value;
      const span = String(existing.duration_us);
      if (![...length.options].some((option) => option.value === span))
        length.add(new Option(`${existing.duration_us / 1_000_000} s`, span));
      length.value = span;
    }
    add.textContent = found.existing ? "Change transition" : "Add transition";
    const label = found.existing
      ? `Change the transition at the cut at ${at}`
      : `Add a transition at the cut at ${at}`;
    add.title = label;
    add.setAttribute("aria-label", label);
    remove.setAttribute("aria-label", `Remove the transition at ${at}`);
  }

  async function apply(): Promise<void> {
    const found = target();
    if (!found || context.busy()) return;
    const { kind: style, color } = parseChoice(kind.value);
    const durationUs = Number(length.value);
    await context.run(
      (current) =>
        window.desktop.applyManualTransition({
          schema_version: "1.0",
          projectId: current.id,
          draftId: current.draft.id,
          baseRevisionId: current.draft.baseRevisionId,
          expectedSequence: current.draft.sequence,
          expectedTimelineSha256: current.draft.timelineSha256,
          transitionId: found.existing?.transition_id ?? null,
          atUs: found.cut.atUs,
          kind: style,
          durationUs,
          color,
        }),
      "The transition could not be saved. Try again.",
      Math.max(0, found.cut.atUs - Math.floor(durationUs / 2)),
    );
  }

  add.addEventListener("click", () => void apply());
  // Changing the style or length of an existing transition applies at once.
  for (const select of [kind, length])
    select.addEventListener("change", () => {
      if (target()?.existing) void apply();
    });
  remove.addEventListener("click", () => {
    const found = target();
    if (!found?.existing || context.busy()) return;
    const id = found.existing.transition_id;
    void context.run(
      (current) =>
        window.desktop.removeManualTransition({
          schema_version: "1.0",
          projectId: current.id,
          draftId: current.draft.id,
          baseRevisionId: current.draft.baseRevisionId,
          expectedSequence: current.draft.sequence,
          expectedTimelineSha256: current.draft.timelineSha256,
          transitionId: id,
        }),
      "The transition could not be removed. Try again.",
      context.position(),
    );
  });

  return { render };
}
