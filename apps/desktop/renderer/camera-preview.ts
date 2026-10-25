import type { ProjectView } from "../../../packages/domain/src/project-view.ts";
import type { CameraView } from "../../../packages/domain/src/camera-view.ts";
import {
  cameraLayersAt,
  layoutIntervals,
  type LayoutInterval,
  type LayoutShape,
} from "../../../packages/domain/src/layouts.ts";
import { viewSourceAt } from "../../../packages/domain/src/speed.ts";

/**
 * Shows the camera over the preview as the draft's layouts arrange it: a
 * corner camera in its shape, or the camera filling the picture, with the
 * same placement, gliding and dissolving as export (`cameraLayersAt`). The
 * camera plays from its own video, kept in step with the screen's position.
 * The elements ignore the pointer and sit under the graphics.
 */
export function setupCameraPreview(preview: HTMLElement): {
  render(
    project: ProjectView | undefined,
    positionUs: number,
    playing: boolean,
  ): void;
  setCamera(view: CameraView | null): void;
  /** The layout changes in effect, in output time. */
  intervals(): LayoutInterval[];
} {
  const make = (className: string) => {
    const wrapper = document.createElement("div");
    wrapper.className = `camera-layer ${className}`;
    wrapper.hidden = true;
    wrapper.setAttribute("aria-hidden", "true");
    const video = document.createElement("video");
    video.className = "camera-video";
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.disablePictureInPicture = true;
    video.controls = false;
    video.hidden = true;
    wrapper.append(video);
    preview.append(wrapper);
    return { wrapper, video };
  };
  const pip = make("camera-pip");
  const full = make("camera-full");
  let camera: CameraView | null = null;
  let loaded = "";
  let key = "";
  let intervals: LayoutInterval[] = [];

  function mediaBox(): {
    left: number;
    top: number;
    width: number;
    height: number;
  } {
    const box = preview.getBoundingClientRect();
    const visible =
      preview.querySelector<HTMLVideoElement>(
        "video.preview-video:not([hidden])",
      ) ?? preview.querySelector<HTMLCanvasElement>("canvas");
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

  function radius(shape: LayoutShape, width: number, height: number): string {
    if (shape === "circle") return "50%";
    if (shape === "rounded") return `${Math.min(width, height) * 0.12}px`;
    return "0";
  }

  /** Crops the camera picture around the focus point, like export. */
  function frame(
    video: HTMLVideoElement,
    width: number,
    height: number,
    zoom: number,
    focusX: number,
    focusY: number,
  ): void {
    if (zoom <= 1.0001) {
      video.style.transform = "";
      return;
    }
    const size = 1 / zoom;
    const x = Math.min(1 - size, Math.max(0, focusX - size / 2));
    const y = Math.min(1 - size, Math.max(0, focusY - size / 2));
    video.style.transformOrigin = "0 0";
    video.style.transform = `matrix(${zoom}, 0, 0, ${zoom}, ${-x * zoom * width}, ${-y * zoom * height})`;
  }

  /** Keeps a camera video at the position the screen has reached. */
  function follow(
    video: HTMLVideoElement,
    targetSeconds: number,
    speed: number,
    playing: boolean,
    visible: boolean,
  ): void {
    if (!visible) {
      if (!video.paused) video.pause();
      return;
    }
    const target = Math.max(0, targetSeconds);
    const drift = Math.abs(video.currentTime - target);
    if (video.playbackRate !== speed) video.playbackRate = speed;
    if (playing) {
      if (video.paused || drift > 0.3) video.currentTime = target;
      if (video.paused) void video.play().catch(() => undefined);
    } else {
      if (!video.paused) video.pause();
      if (drift > 0.02) video.currentTime = target;
    }
  }

  function render(
    project: ProjectView | undefined,
    us: number,
    playing: boolean,
  ): void {
    const nextKey = project
      ? `${project.id}:${project.draft.sequence}:${project.draft.timelineSha256}`
      : "";
    if (nextKey !== key) {
      key = nextKey;
      intervals =
        project?.clips && project.layouts?.length
          ? layoutIntervals(project.layouts, project.clips)
          : [];
    }
    // A hidden layer's video is hidden too, so nothing that looks for the
    // picture on screen ever takes the camera for it.
    const sync = () => {
      pip.video.hidden = pip.wrapper.hidden;
      full.video.hidden = full.wrapper.hidden;
    };
    const shown = !!project && !!camera?.linked && intervals.length > 0;
    if (!shown || !project || !camera) {
      pip.wrapper.hidden = true;
      full.wrapper.hidden = true;
      follow(pip.video, 0, 1, false, false);
      follow(full.video, 0, 1, false, false);
      sync();
      return;
    }
    const source = `media/${project.id}/camera`;
    if (loaded !== `${project.id}:${camera.file_name}`) {
      loaded = `${project.id}:${camera.file_name}`;
      for (const item of [pip, full])
        item.video.src = new URL(source, location.href).href;
    }
    const box = mediaBox();
    const layers = cameraLayersAt(intervals, us, {
      canvasAspect: box.width / Math.max(1, box.height),
      cameraAspect: (camera.width ?? 16) / (camera.height ?? 9),
    });
    const clip = project.clips?.find(
      (item) => us >= item.timelineStartUs && us < item.timelineEndUs,
    );
    const sourceUs = clip ? viewSourceAt(clip, us) : 0;
    const target = (sourceUs + camera.offset_us) / 1_000_000;
    const speed = Math.min(16, Math.max(1, clip?.speed ?? 1));
    const placed = layers.pip;
    pip.wrapper.hidden = !placed;
    if (placed) {
      const width = placed.width * box.width;
      const height = placed.height * box.height;
      Object.assign(pip.wrapper.style, {
        left: `${box.left + placed.x * box.width}px`,
        top: `${box.top + placed.y * box.height}px`,
        width: `${width}px`,
        height: `${height}px`,
        opacity: String(placed.opacity),
        borderRadius: radius(placed.shape, width, height),
      });
      frame(
        pip.video,
        width,
        height,
        placed.faceZoom,
        placed.focusX,
        placed.focusY,
      );
    }
    full.wrapper.hidden = layers.full <= 0;
    if (layers.full > 0) {
      Object.assign(full.wrapper.style, {
        left: `${box.left}px`,
        top: `${box.top}px`,
        width: `${box.width}px`,
        height: `${box.height}px`,
        opacity: String(layers.full),
        borderRadius: "0",
      });
      frame(
        full.video,
        box.width,
        box.height,
        layers.fullZoom,
        layers.fullFocusX,
        layers.fullFocusY,
      );
    }
    sync();
    follow(pip.video, target, speed, playing, !!placed);
    follow(full.video, target, speed, playing, layers.full > 0);
  }

  return {
    render,
    setCamera: (view) => {
      camera = view;
      if (!view?.linked) loaded = "";
    },
    intervals: () => intervals,
  };
}
