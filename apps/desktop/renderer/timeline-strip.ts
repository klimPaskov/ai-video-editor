import type { ProjectView } from "../../../packages/domain/src/project-view.ts";
import type { ZoomInterval } from "../../../packages/domain/src/zoom.ts";

/**
 * Proportional view of the draft timeline: one block per visible clip, the
 * in/out marks and the playhead. It only reflects state; clicking seeks.
 * The position slider remains the keyboard-accessible control.
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
  ): void;
  playhead(us: number): void;
} {
  const { host } = options;
  const track = host.querySelector<HTMLElement>(".timeline-track")!;
  const clips = host.querySelector<HTMLElement>(".timeline-clips")!;
  const markLayer = host.querySelector<HTMLElement>(".timeline-marks")!;
  const zoomLayer = host.querySelector<HTMLElement>(".timeline-zooms")!;
  const head = host.querySelector<HTMLElement>(".timeline-playhead")!;
  const summary = host.querySelector<HTMLElement>(".timeline-summary")!;
  let durationUs = 0;
  let key = "";
  let current: ProjectView | undefined;

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
          block.style.left = percent(clip.timelineStartUs);
          block.style.width = `calc(${percent(clip.timelineEndUs - clip.timelineStartUs)} - 2px)`;
          block.textContent =
            project.clips!.length > 1
              ? `${index + 1}`
              : (sources[0]?.name ?? "");
          if (clip.speed) {
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
      const parts = project.clips.length;
      // Footage kept is measured in source time, so speed-ups do not count.
      const keptUs = project.clips.reduce(
        (sum, clip) => sum + clip.sourceEndUs - clip.sourceStartUs,
        0,
      );
      const count = `${parts} ${parts === 1 ? "clip" : "clips"}`;
      summary.textContent =
        keptUs === durationUs
          ? originalUs > keptUs
            ? `${count} · ${options.time(durationUs)} of ${options.time(originalUs)} kept`
            : `${count} · ${options.time(durationUs)}`
          : // Sped-up parts make the output shorter than the footage kept.
            originalUs > keptUs
            ? `${count} · ${options.time(durationUs)} from ${options.time(keptUs)} of ${options.time(originalUs)} footage`
            : `${count} · ${options.time(durationUs)} from ${options.time(originalUs)} footage`;
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
