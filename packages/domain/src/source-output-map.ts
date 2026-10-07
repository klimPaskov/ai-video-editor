import type { ProjectClipView } from "./project-view.ts";

/** Maps a source-time point only when one committed clip visibly contains it. */
export function mapSourceTimeToOutputTime(
  clips: readonly ProjectClipView[] | undefined,
  timelineDurationUs: number,
  sourceId: string,
  sourceTimeUs: number,
): number | undefined {
  if (
    !clips ||
    clips.length === 0 ||
    typeof sourceId !== "string" ||
    !sourceId ||
    !Number.isSafeInteger(timelineDurationUs) ||
    timelineDurationUs <= 0 ||
    !Number.isSafeInteger(sourceTimeUs) ||
    sourceTimeUs < 0
  )
    return undefined;

  let match: ProjectClipView | undefined;
  for (const clip of clips) {
    if (
      !Number.isSafeInteger(clip.timelineStartUs) ||
      !Number.isSafeInteger(clip.timelineEndUs) ||
      !Number.isSafeInteger(clip.sourceStartUs) ||
      !Number.isSafeInteger(clip.sourceEndUs) ||
      clip.timelineStartUs < 0 ||
      clip.timelineEndUs <= clip.timelineStartUs ||
      clip.sourceStartUs < 0 ||
      clip.sourceEndUs <= clip.sourceStartUs
    )
      return undefined;
    if (
      clip.sourceId === sourceId &&
      sourceTimeUs >= clip.sourceStartUs &&
      sourceTimeUs < clip.sourceEndUs
    ) {
      if (match) return undefined;
      match = clip;
    }
  }
  if (!match || match.timelineEndUs > timelineDurationUs) return undefined;
  const outputTimeUs =
    match.timelineStartUs + sourceTimeUs - match.sourceStartUs;
  if (
    !Number.isSafeInteger(outputTimeUs) ||
    outputTimeUs < match.timelineStartUs ||
    outputTimeUs >= match.timelineEndUs ||
    outputTimeUs >= timelineDurationUs
  )
    return undefined;
  return outputTimeUs;
}
