import type { CameraView } from "../../../packages/domain/src/camera-view.ts";
import type {
  ProjectDraftView,
  ProjectView,
} from "../../../packages/domain/src/project-view.ts";
import {
  layoutIntervals,
  type LayoutCorner,
  type LayoutInterval,
  type LayoutKind,
  type LayoutShape,
} from "../../../packages/domain/src/layouts.ts";
import type { Reply } from "../src/bridge.ts";

/**
 * The Edit step's Camera tools. Without a camera video the only control is
 * Add camera video. With one, a layout (screen only, camera, camera in a
 * corner) is chosen for the picture from the playhead on; a change already
 * there is replaced, and the one in effect can be removed. The offset
 * buttons move the camera against the screen by a tenth of a second.
 */
export interface CameraToolsContext {
  root: HTMLElement;
  add: HTMLButtonElement;
  remove: HTMLButtonElement;
  layout: HTMLSelectElement;
  corner: HTMLSelectElement;
  size: HTMLSelectElement;
  shape: HTMLSelectElement;
  apply: HTMLButtonElement;
  removeChange: HTMLButtonElement;
  earlier: HTMLButtonElement;
  later: HTMLButtonElement;
  status: HTMLElement;
  /** Output position of the playhead. */
  position(): number;
  busy(): boolean;
  time(us: number): string;
  /** The project the tools act on. */
  project(): ProjectView | undefined;
  /** The camera changed (linked, removed or moved against the screen). */
  changed(view: CameraView): void;
  /** Shows a plain failure message. */
  fail(message: string): void;
  run(
    work: (project: ProjectView) => Promise<Reply<ProjectDraftView>>,
    failure: string,
    seekUs: number,
  ): Promise<void>;
}

const offsetStepUs = 100_000;
/** A change this close to the playhead is the one the buttons act on. */
const nearUs = 150_000;

export function setupCameraTools(context: CameraToolsContext): {
  /** Loads the camera of the project (when it changes) and draws the tools. */
  render(project: ProjectView | undefined): void;
  view(): CameraView | null;
} {
  let camera: CameraView | null = null;
  let loadedFor = "";
  let loading = false;
  let busyHere = false;

  const request = (project: ProjectView) => ({
    schema_version: "1.0" as const,
    project_id: project.id,
  });

  async function load(project: ProjectView): Promise<void> {
    if (loading) return;
    loading = true;
    try {
      const reply = await window.desktop.getCamera(request(project));
      if (reply.ok && context.project()?.id === project.id) {
        camera = reply.value;
        loadedFor = project.id;
        context.changed(reply.value);
        paint();
      }
    } finally {
      loading = false;
    }
  }

  function inEffect(): LayoutInterval | undefined {
    const project = context.project();
    if (!project?.clips || !project.layouts?.length) return undefined;
    const intervals = layoutIntervals(project.layouts, project.clips);
    const at = context.position();
    return intervals.filter((item) => item.startUs <= at).at(-1);
  }

  /** The change nearest the playhead, when it is right there. */
  function here(): LayoutInterval | undefined {
    const project = context.project();
    if (!project?.clips || !project.layouts?.length) return undefined;
    const at = context.position();
    return layoutIntervals(project.layouts, project.clips).find(
      (item) => Math.abs(item.startUs - at) <= nearUs,
    );
  }

  function paint(): void {
    const project = context.project();
    const linked = !!camera?.linked;
    const busy = context.busy() || busyHere;
    context.add.hidden = linked;
    context.add.disabled = busy || !project;
    for (const item of [
      context.remove,
      context.layout,
      context.apply,
      context.removeChange,
      context.earlier,
      context.later,
      context.status,
    ])
      item.hidden = !linked;
    const kind = context.layout.value as LayoutKind;
    for (const item of [context.corner, context.size, context.shape])
      item.hidden = !linked || kind !== "pip";
    for (const item of [
      context.remove,
      context.layout,
      context.corner,
      context.size,
      context.shape,
      context.apply,
      context.earlier,
      context.later,
    ])
      item.disabled = busy;
    const change = here();
    context.apply.textContent = change ? "Change layout" : "Layout from here";
    context.apply.setAttribute(
      "aria-label",
      change
        ? "Change the layout that starts here"
        : `Change the layout from ${context.time(context.position())}`,
    );
    const active = inEffect();
    context.removeChange.hidden = !linked || !active;
    context.removeChange.disabled = busy;
    if (linked && camera) {
      const seconds = camera.offset_us / 1_000_000;
      context.status.textContent =
        seconds === 0
          ? "Camera in sync"
          : `Camera ${seconds > 0 ? "+" : "−"}${Math.abs(seconds).toFixed(1)} s`;
    }
  }

  async function camerasCall(
    call: () => Promise<Reply<CameraView>>,
    failure: string,
  ): Promise<void> {
    busyHere = true;
    paint();
    try {
      const reply = await call();
      if (reply.ok) {
        camera = reply.value;
        context.changed(reply.value);
      } else context.fail(reply.message || failure);
    } catch {
      context.fail(failure);
    } finally {
      busyHere = false;
      paint();
    }
  }

  context.add.addEventListener("click", () => {
    const project = context.project();
    if (!project) return;
    void camerasCall(
      () => window.desktop.chooseCamera(request(project)),
      "The camera video could not be added. Try again.",
    );
  });
  context.remove.addEventListener("click", () => {
    const project = context.project();
    if (!project) return;
    void camerasCall(
      () => window.desktop.removeCamera(request(project)),
      "The camera could not be removed. Undo its layout changes first.",
    );
  });
  for (const [button, direction] of [
    [context.earlier, -1],
    [context.later, 1],
  ] as const)
    button.addEventListener("click", () => {
      const project = context.project();
      if (!project || !camera) return;
      void camerasCall(
        () =>
          window.desktop.setCameraOffset({
            ...request(project),
            offset_us: camera!.offset_us + direction * offsetStepUs,
          }),
        "The camera could not be moved. Try again.",
      );
    });
  context.layout.addEventListener("change", paint);
  context.apply.addEventListener("click", () => {
    const existing = here();
    const kind = context.layout.value as LayoutKind;
    const at = existing ? existing.startUs : context.position();
    const sizes: Record<string, number> = {
      small: 0.18,
      medium: 0.24,
      large: 0.34,
    };
    void context.run(
      (current) =>
        window.desktop.applyManualLayout({
          schema_version: "1.0",
          projectId: current.id,
          draftId: current.draft.id,
          baseRevisionId: current.draft.baseRevisionId,
          expectedSequence: current.draft.sequence,
          expectedTimelineSha256: current.draft.timelineSha256,
          layoutId: existing?.layoutId ?? null,
          atUs: at,
          kind,
          corner: context.corner.value as LayoutCorner,
          size: sizes[context.size.value] ?? 0.24,
          shape: context.shape.value as LayoutShape,
          faceZoom: 1,
          focusX: 0.5,
          focusY: 0.5,
          moveUs: 600_000,
        }),
      "The layout could not be saved. Try again.",
      at,
    );
  });
  context.removeChange.addEventListener("click", () => {
    const active = inEffect();
    if (!active) return;
    void context.run(
      (current) =>
        window.desktop.removeManualLayout({
          schema_version: "1.0",
          projectId: current.id,
          draftId: current.draft.id,
          baseRevisionId: current.draft.baseRevisionId,
          expectedSequence: current.draft.sequence,
          expectedTimelineSha256: current.draft.timelineSha256,
          layoutId: active.layoutId,
        }),
      "The layout change could not be removed. Try again.",
      context.position(),
    );
  });

  return {
    render(project) {
      if (!project) {
        camera = null;
        loadedFor = "";
        paint();
        return;
      }
      if (loadedFor !== project.id) void load(project);
      paint();
    },
    view: () => camera,
  };
}
