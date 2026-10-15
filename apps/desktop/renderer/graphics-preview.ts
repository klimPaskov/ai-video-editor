import type { ProjectView } from "../../../packages/domain/src/project-view.ts";
import {
  graphicIntervals,
  type GraphicInterval,
} from "../../../packages/domain/src/graphics.ts";
import { syncStage, type StageGraphic } from "./stage-control.ts";

/**
 * Shows the draft's motion graphics over the preview through the graphics
 * stage page, exactly as export renders them. The stage frame ignores the
 * pointer and sits under the captions.
 */
export function setupGraphicsPreview(preview: HTMLElement): {
  render(project: ProjectView | undefined, positionUs: number): void;
  intervals(): GraphicInterval[];
} {
  const frame = document.createElement("iframe");
  frame.className = "graphics-stage";
  frame.title = "Graphics";
  frame.tabIndex = -1;
  frame.setAttribute("aria-hidden", "true");
  frame.src = "stage.html";
  frame.hidden = true;
  preview.append(frame);
  let ready = false;
  let pending: { project: ProjectView | undefined; us: number } | undefined;
  frame.addEventListener("load", () => {
    ready = true;
    if (pending) render(pending.project, pending.us);
  });
  let key = "";
  let intervals: GraphicInterval[] = [];

  function mediaBox(): {
    left: number;
    top: number;
    width: number;
    height: number;
  } {
    const box = preview.getBoundingClientRect();
    const visible =
      preview.querySelector<HTMLVideoElement>("video:not([hidden])") ??
      preview.querySelector<HTMLCanvasElement>("canvas");
    const width =
      visible instanceof HTMLVideoElement
        ? visible.videoWidth
        : (visible?.width ?? 0);
    const height =
      visible instanceof HTMLVideoElement
        ? visible.videoHeight
        : (visible?.height ?? 0);
    if (!width || !height)
      return { left: 0, top: 0, width: box.width, height: box.height };
    const scale = Math.min(box.width / width, box.height / height);
    return {
      left: (box.width - width * scale) / 2,
      top: (box.height - height * scale) / 2,
      width: width * scale,
      height: height * scale,
    };
  }

  function render(project: ProjectView | undefined, us: number): void {
    const nextKey = project
      ? `${project.id}:${project.draft.sequence}:${project.draft.timelineSha256}`
      : "";
    if (nextKey !== key) {
      key = nextKey;
      intervals =
        project?.graphics?.length && project.clips
          ? graphicIntervals(
              project.graphics,
              project.clips,
              project.timeline.durationUs,
            )
          : [];
    }
    const active = intervals.some(
      (item) => us >= item.startUs && us < item.endUs,
    );
    frame.hidden = !active;
    if (!active || !project) return;
    if (!ready || !frame.contentDocument) {
      pending = { project, us };
      return;
    }
    pending = undefined;
    const box = mediaBox();
    // The stage is the output size; it is scaled down onto the picture.
    const width = project.source.width,
      height = project.source.height;
    Object.assign(frame.style, {
      left: `${box.left}px`,
      top: `${box.top}px`,
      width: `${box.width}px`,
      height: `${box.height}px`,
    });
    const graphics: StageGraphic[] = intervals.map((item) => ({
      id: item.graphicId,
      startUs: item.startUs,
      endUs: item.endUs,
      layer: item.layer,
      html: item.html,
      css: item.css,
    }));
    syncStage(
      frame.contentDocument,
      { width, height, scale: box.width / width, graphics },
      us,
    );
  }

  return { render, intervals: () => intervals };
}
