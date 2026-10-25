import type { ProjectView } from "../../../packages/domain/src/project-view.ts";
import type { GraphicInterval } from "../../../packages/domain/src/graphics.ts";
import type { ZoomInterval } from "../../../packages/domain/src/zoom.ts";

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
  const graphicLayer = host.querySelector<HTMLElement>(".timeline-graphics")!;
  const head = host.querySelector<HTMLElement>(".timeline-playhead")!;
  const summary = host.querySelector<HTMLElement>(".timeline-summary")!;
  let durationUs = 0;
  let key = "";
  let current: ProjectView | undefined;

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
