import type { ProjectView } from "../../../packages/domain/src/project-view.ts";
import type { GraphicInterval } from "../../../packages/domain/src/graphics.ts";
import type { ZoomInterval } from "../../../packages/domain/src/zoom.ts";
import type { MediaFrame } from "../../../packages/domain/src/library.ts";
import {
  rulerTicks,
  stripCellTimes,
} from "../../../packages/domain/src/timeline-strip.ts";

/**
 * Proportional view of the draft timeline: one continuous bar coloured by
 * recording, with a hairline at each cut, the in/out marks and the playhead.
 * After an automatic edit there can be a hundred parts, so parts carry no
 * labels. It only reflects state; clicking seeks. The position slider
 * remains the keyboard-accessible control.
 */
export interface TimelineMarks {
  inUs?: number | undefined;
  outUs?: number | undefined;
}

export function setupTimelineStrip(options: {
  host: HTMLElement;
  seek: (us: number) => void;
  time: (us: number) => string;
}): {
  render(
    project: ProjectView | undefined,
    marks: TimelineMarks,
    zooms?: readonly ZoomInterval[],
    graphics?: readonly GraphicInterval[],
  ): void;
  playhead(us: number): void;
} {
  const { host } = options;
  const track = host.querySelector<HTMLElement>(".timeline-track")!;
  const clips = host.querySelector<HTMLElement>(".timeline-clips")!;
  const markLayer = host.querySelector<HTMLElement>(".timeline-marks")!;
  const zoomLayer = host.querySelector<HTMLElement>(".timeline-zooms")!;
  const thumbs = host.querySelector<HTMLElement>(".timeline-thumbs")!;
  const ruler = host.querySelector<HTMLElement>(".timeline-ruler")!;
  const graphicLayer = host.querySelector<HTMLElement>(".timeline-graphics")!;
  const head = host.querySelector<HTMLElement>(".timeline-playhead")!;
  const summary = host.querySelector<HTMLElement>(".timeline-summary")!;
  let durationUs = 0;
  let key = "";
  let current: ProjectView | undefined;
  // The filmstrip of the current draft, and the cell count it was asked for.
  let thumbRun = 0;
  let thumbCells = 0;
  let resizeTimer: number | undefined;

  const minutes = (us: number): string => {
    const seconds = Math.round(us / 1_000_000);
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  };
  const percent = (us: number): string =>
    `${durationUs > 0 ? Math.min(100, Math.max(0, (us / durationUs) * 100)) : 0}%`;

  track.addEventListener("click", (event) => {
    if (durationUs <= 0) return;
    const box = clips.getBoundingClientRect();
    const ratio = Math.min(
      1,
      Math.max(0, (event.clientX - box.left) / Math.max(1, box.width)),
    );
    options.seek(Math.round(ratio * durationUs));
  });

  /** Time labels along the strip, at a step that keeps them apart. */
  function drawRuler(): void {
    const width = clips.getBoundingClientRect().width;
    const ticks = rulerTicks(durationUs, width);
    ruler.replaceChildren(
      ...ticks.map((tick, index) => {
        const mark = document.createElement("span");
        mark.className = "timeline-tick";
        mark.style.left = `calc((100% - 0px) * ${tick.us / Math.max(1, durationUs)})`;
        // A label at the far end would run out of the strip.
        if (index > 0 && tick.us / Math.max(1, durationUs) > 0.94)
          mark.classList.add("last");
        mark.textContent = tick.label;
        return mark;
      }),
    );
  }

  function pixels(frame: MediaFrame): ImageData {
    const binary = atob(frame.rgbaBase64);
    const bytes = new Uint8ClampedArray(binary.length);
    for (let index = 0; index < binary.length; index++)
      bytes[index] = binary.charCodeAt(index);
    return new ImageData(bytes, frame.width, frame.height);
  }

  /**
   * Small pictures of the edit under the parts, one per cell. They are
   * cosmetic and loaded after the strip is drawn; if they cannot be had
   * (or the draft changes meanwhile) the plain bar stays.
   */
  async function loadThumbs(project: ProjectView): Promise<void> {
    const run = ++thumbRun;
    const times = stripCellTimes(
      project.timeline.durationUs,
      clips.getBoundingClientRect().width,
    );
    thumbCells = times.length;
    if (times.length === 0 || !window.desktop?.readProjectStrip) return;
    let reply;
    try {
      reply = await window.desktop.readProjectStrip({
        projectId: project.id,
        draftId: project.draft.id,
        baseRevisionId: project.draft.baseRevisionId,
        expectedSequence: project.draft.sequence,
        expectedTimelineSha256: project.draft.timelineSha256,
        timesUs: times,
      });
    } catch {
      return;
    }
    if (
      run !== thumbRun ||
      !reply.ok ||
      reply.value.status !== "ready" ||
      current?.id !== project.id
    )
      return;
    const cells = reply.value.frames;
    const cellShare = 1 / cells.length;
    const nodes: HTMLCanvasElement[] = [];
    for (const [index, cell] of cells.entries()) {
      if (!cell.frame) continue;
      const canvas = document.createElement("canvas");
      canvas.width = cell.frame.width;
      canvas.height = cell.frame.height;
      canvas.getContext("2d")?.putImageData(pixels(cell.frame), 0, 0);
      canvas.style.left = `${index * cellShare * 100}%`;
      canvas.style.width = `${cellShare * 100 + 0.2}%`;
      nodes.push(canvas);
    }
    thumbs.replaceChildren(...nodes);
    thumbs.classList.toggle("filled", nodes.length > 0);
  }

  // A resized strip gets the cell count that fits it, once it settles.
  new ResizeObserver(() => {
    if (!current?.clips || durationUs <= 0) return;
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      drawRuler();
      const cells = stripCellTimes(
        durationUs,
        clips.getBoundingClientRect().width,
      ).length;
      if (current?.clips && cells !== thumbCells) void loadThumbs(current);
    }, 300);
  }).observe(clips);

  function playhead(us: number): void {
    head.style.left = `calc(4px + (100% - 8px) * ${durationUs > 0 ? Math.min(1, Math.max(0, us / durationUs)) : 0})`;
    if (!current?.clips) return;
    for (const [index, clip] of current.clips.entries()) {
      const block = clips.children[index];
      block?.classList.toggle(
        "current",
        current.clips.length > 1 &&
          us >= clip.timelineStartUs &&
          us < clip.timelineEndUs,
      );
    }
  }

  function render(
    project: ProjectView | undefined,
    marks: TimelineMarks,
    zooms: readonly ZoomInterval[] = [],
    graphics: readonly GraphicInterval[] = [],
  ): void {
    current = project;
    host.hidden = !project?.clips;
    if (!project?.clips) return;
    durationUs = project.timeline.durationUs;
    const nextKey = `${project.id}:${project.draft.sequence}:${project.draft.timelineSha256}`;
    if (nextKey !== key) {
      key = nextKey;
      const sources = project.sources ?? [project.source];
      clips.replaceChildren(
        ...project.clips.map((clip, index) => {
          const block = document.createElement("div");
          const sourceIndex = sources.findIndex(
            (source) => source.id === clip.sourceId,
          );
          block.className =
            sourceIndex > 0 ? "timeline-clip second-source" : "timeline-clip";
          if (clip.speed) block.classList.add("sped");
          if (index > 0) block.classList.add("cut");
          const share =
            (clip.timelineEndUs - clip.timelineStartUs) /
            Math.max(1, durationUs);
          block.style.left = percent(clip.timelineStartUs);
          block.style.width = percent(
            clip.timelineEndUs - clip.timelineStartUs,
          );
          // A single clip is named after its recording; parts are not.
          if (project.clips!.length === 1)
            block.textContent = sources[0]?.name ?? "";
          // The speed shows where the part is wide enough to read it.
          if (clip.speed && share >= 0.04) {
            const badge = document.createElement("span");
            badge.className = "timeline-speed";
            badge.textContent = `${clip.speed}×`;
            block.append(badge);
          }
          return block;
        }),
      );
      const originalUs = sources.reduce(
        (sum, source) => sum + source.durationUs,
        0,
      );
      // Only the edited length against the recordings; the player shows the
      // exact time.
      summary.textContent =
        durationUs < originalUs
          ? `${minutes(durationUs)} of ${minutes(originalUs)}`
          : "";
      summary.hidden = durationUs >= originalUs;
      drawRuler();
      thumbs.classList.remove("filled");
      thumbs.replaceChildren();
      void loadThumbs(project);
    }
    const layers: HTMLElement[] = [];
    const { inUs, outUs } = marks;
    const box = (startUs: number, endUs: number, name: string) => {
      const layer = document.createElement("div");
      layer.className = name;
      layer.style.left = `calc(4px + (100% - 8px) * ${startUs / Math.max(1, durationUs)})`;
      if (endUs > startUs)
        layer.style.width = `calc((100% - 8px) * ${(endUs - startUs) / Math.max(1, durationUs)})`;
      return layer;
    };
    if (inUs !== undefined && outUs !== undefined && inUs < outUs)
      layers.push(box(inUs, outUs, "timeline-range"));
    else {
      if (inUs !== undefined) layers.push(box(inUs, inUs, "timeline-mark"));
      if (outUs !== undefined) layers.push(box(outUs, outUs, "timeline-mark"));
    }
    markLayer.replaceChildren(...layers);
    graphicLayer.replaceChildren(
      ...graphics.map((graphic) => {
        const bar = document.createElement("div");
        // A transition is a small marker over its cut, not a labelled bar.
        const transition = graphic.graphicId.startsWith("transition-");
        bar.className = transition
          ? "timeline-graphic timeline-transition"
          : "timeline-graphic";
        bar.style.left = `calc(4px + (100% - 8px) * ${graphic.startUs / Math.max(1, durationUs)})`;
        bar.style.width = `calc((100% - 8px) * ${(graphic.endUs - graphic.startUs) / Math.max(1, durationUs)})`;
        if (!transition) bar.textContent = graphic.name;
        bar.title = graphic.name;
        return bar;
      }),
    );
    zoomLayer.replaceChildren(
      ...zooms.map((zoom) => {
        const bar = document.createElement("div");
        bar.className = "timeline-zoom";
        bar.style.left = `calc(4px + (100% - 8px) * ${zoom.startUs / Math.max(1, durationUs)})`;
        bar.style.width = `calc((100% - 8px) * ${(zoom.endUs - zoom.startUs) / Math.max(1, durationUs)})`;
        bar.textContent = `${Number(zoom.scale.toFixed(2))}×`;
        return bar;
      }),
    );
  }

  return { render, playhead };
}
