import type { MagicWandPreset } from "../../../packages/domain/src/magic-wand.ts";

/**
 * The rough cut (Magic Edit) is an editorial pass by Claude, never a
 * mechanical one (docs/47, docs/32): the local pause, filler and repeat
 * analysis is evidence for the model, not a list of cuts. This playbook is
 * appended to the editor instructions for the rough-cut run.
 */
export const roughCutPlaybook = `# Rough cut playbook

You are making the rough cut of a recording: a story edit, not a cleanup pass. Only cut, trim, split and restore; do not add zooms, speed changes, captions, audio settings or graphics (a later pass does those). Work until the cut is done; do not stop to ask questions.

## 1. Understand the whole recording first
- Read the project and timeline summaries, then read the entire transcript of every source in pages, in order, before cutting anything.
- Work out what the video is about, its sections, and the line of the story a viewer should follow. Look at a few rendered pictures (start, middle, end, and wherever the screen matters) to see what is shown.

## 2. Decide what the story needs
Remove, when the transcript and pictures support it:
- ideas said more than once: keep the clearest, most complete version, and keep any unique detail from the others;
- retakes: the speaker restarts or redoes a sentence, an explanation or a demonstration; keep the final complete take;
- false starts, abandoned sentences, self-corrections and asides to themselves ("wait", "let me redo that");
- tangents that do not serve the video, and dead time such as waiting for something to load with nothing said;
- long silences, fillers and stumbles between sentences.
Keep: setup and context, examples, qualifications and exceptions, names, numbers and negations, transitions between sections, and pauses a demonstration needs. When unsure, keep it.

The evidence list in the request (long pauses, fillers, repeated wording found by local analysis) shows where to look. It is not a list of cuts: confirm each one against the transcript before acting, and find the story-level cuts it cannot see.

## 3. Cut carefully
- Cut on sentence boundaries; leave about 0.2–0.3 s of breathing room around a join.
- Use cut.delete_ranges for several confirmed ranges at once (latest first, non-overlapping), and refresh the timeline summary after each change; times move after every cut.
- To bring back something cut by mistake, use cut.restore_range.

## 4. Check the result
- Reread the edited result from start to finish: the timeline summary lists every clip in order with its source and source range; read exactly those source ranges with transcript.get_range, in timeline order. Every join must read naturally, and nothing needed to follow the video may be missing; restore anything that was.
- Look at a rendered picture just after a few important joins.

## 5. Finish
Reply with a short plain summary: the story you kept, what you removed grouped by kind (repeated ideas, retakes, false starts, tangents, dead air), and anything you deliberately kept that a viewer might expect gone. Every cut can be undone in Edit.`;

const presetGuidance: Record<MagicWandPreset, string> = {
  gentle:
    "Gentle: remove only clear retakes, repeated ideas, false starts and long dead air. Keep the speaker's natural rhythm and most asides.",
  balanced:
    "Balanced: a normal story edit. Remove repeated ideas, retakes, false starts, tangents, dead air and distracting fillers.",
  tight:
    "Tight: a brisk edit. Also remove weaker repeats of a point, minor asides and shorter pauses, while keeping everything the story needs.",
};

/**
 * One piece of local evidence: where it is in its recording (the time the
 * transcript tool uses) and where that is in the current edit (the time the
 * cut tools use).
 */
export interface RoughCutEvidence {
  kind: "pause" | "filler" | "repeated_take";
  sourceId: string;
  sourceStartUs: number;
  sourceEndUs: number;
  startUs: number;
  endUs: number;
}

const evidenceNames: Record<RoughCutEvidence["kind"], string> = {
  pause: "long pause",
  filler: "filler",
  repeated_take: "earlier copy of repeated wording",
};

/** The user message that starts a rough cut. */
export function roughCutRequest(
  preset: MagicWandPreset,
  evidence: readonly RoughCutEvidence[],
  tightened: { pauses: number; fillers: number } | null = null,
): string {
  const shown = evidence.slice(0, 300);
  const lines = [
    "Make the rough cut of this video.",
    `How far to go: ${presetGuidance[preset]}`,
    ...(tightened
      ? [
          `The app has already tightened the pacing: ${tightened.pauses} pauses were shortened and ${tightened.fillers} fillers removed, each cut in a quiet spot. Do not cut pauses or fillers again; times in the timeline summary are current. Spend your effort on the story: repeated ideas, retakes, false starts, tangents and dead time.`,
        ]
      : []),
    "",
    shown.length
      ? `Local analysis evidence, in microseconds: "source" is the recording's own time (as transcript.get_range uses it), "edit" is the current timeline time (as the cut tools use it). Confirm each against the transcript; it is not a cut list.`
      : "Local analysis found no pauses, fillers or repeated wording to point out.",
    ...shown.map(
      (item) =>
        `- ${evidenceNames[item.kind]} · source ${item.sourceId} ${item.sourceStartUs}–${item.sourceEndUs} · edit ${item.startUs}–${item.endUs}`,
    ),
  ];
  if (evidence.length > shown.length)
    lines.push(
      `- …and ${evidence.length - shown.length} more of the same kinds.`,
    );
  return lines.join("\n");
}

/** The short line shown in the conversation for the run's request. */
export function roughCutLabel(preset: MagicWandPreset): string {
  const name = { gentle: "Gentle", balanced: "Balanced", tight: "Tight" }[
    preset
  ];
  return `Rough cut with Claude · ${name}`;
}

/** Tools the rough cut may call: reading, cutting and pictures only. */
export const roughCutTools: ReadonlySet<string> = new Set([
  "project.get_summary",
  "timeline.get_summary",
  "transcript.get_range",
  "media.get_frames",
  "cut.trim_edge",
  "cut.split",
  "cut.delete_range",
  "cut.delete_ranges",
  "cut.restore_range",
]);
