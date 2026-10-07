import type { ProjectView } from "../../../packages/domain/src/project-view.ts";
import {
  zoomAt,
  zoomIntervals,
  zoomWindow,
  type ZoomInterval,
} from "../../../packages/domain/src/zoom.ts";

/** The displayed media rectangle of an element using object-fit: contain. */
export function mediaRect(element: HTMLCanvasElement | HTMLVideoElement): {
  left: number;
  top: number;
  width: number;
  height: number;
} {
  const box = { width: element.clientWidth, height: element.clientHeight };
  const intrinsicWidth =
    element instanceof HTMLVideoElement ? element.videoWidth : element.width;
  const intrinsicHeight =
    element instanceof HTMLVideoElement ? element.videoHeight : element.height;
  if (!intrinsicWidth || !intrinsicHeight) return { left: 0, top: 0, ...box };
  const scale = Math.min(
    box.width / intrinsicWidth,
    box.height / intrinsicHeight,
  );
  const width = intrinsicWidth * scale,
    height = intrinsicHeight * scale;
  return {
    left: (box.width - width) / 2,
    top: (box.height - height) / 2,
    width,
    height,
  };
}

/**
 * Shows the draft's zooms in the preview with a CSS transform, using the
 * same magnification and window as export. The element is clipped so the
 * zoomed picture stays inside its own frame.
 */
export function setupZoomPreview(preview: HTMLElement): {
  render(project: ProjectView | undefined, positionUs: number): void;
  intervals(): ZoomInterval[];
} {
  let key = "";
  let intervals: ZoomInterval[] = [];

  function apply(element: HTMLCanvasElement | HTMLVideoElement, us: number) {
    const zoom = zoomAt(intervals, us);
    if (zoom.scale === 1) {
      element.style.transform = "";
      element.style.clipPath = "";
      return;
    }
    const rect = mediaRect(element);
    const window = zoomWindow(zoom.scale, zoom.centerX, zoom.centerY);
    // Content at media fraction (x, y) of the window moves to the media's
    // top-left corner; the region outside the window is clipped away.
    const s = zoom.scale;
    const originX = rect.left + window.x * rect.width;
    const originY = rect.top + window.y * rect.height;
    const tx = rect.left - s * originX;
    const ty = rect.top - s * originY;
    element.style.transformOrigin = "0 0";
    element.style.transform = `matrix(${s}, 0, 0, ${s}, ${tx}, ${ty})`;
    const right = element.clientWidth - (originX + window.size * rect.width);
    const bottom = element.clientHeight - (originY + window.size * rect.height);
    element.style.clipPath = `inset(${originY}px ${right}px ${bottom}px ${originX}px)`;
  }

  return {
    render(project, positionUs) {
      const nextKey = project
        ? `${project.id}:${project.draft.sequence}:${project.draft.timelineSha256}`
        : "";
      if (nextKey !== key) {
        key = nextKey;
        intervals =
          project?.zooms?.length && project.clips
            ? zoomIntervals(project.zooms, project.clips)
            : [];
      }
      for (const element of preview.querySelectorAll<
        HTMLCanvasElement | HTMLVideoElement
      >("canvas, video"))
        apply(element, positionUs);
    },
    intervals: () => intervals,
  };
}
