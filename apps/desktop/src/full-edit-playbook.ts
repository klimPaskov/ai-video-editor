import type { ClaudeFullEditBrief } from "../../../packages/domain/src/claude-view.ts";

/**
 * The editing playbook for a full AI edit (ADR 0019, docs/50). It is part of
 * the system prompt of the full-edit run, after the editor instructions.
 */
export const fullEditPlaybook = `# Full edit playbook

You are editing one whole video from start to finish for a creator. The result should look deliberate and professional while staying easy to follow. Work in this order and keep going until the video is done; do not stop to ask questions.

## 1. Understand before editing
- Read the project and timeline summaries, then read the whole transcript in pages.
- Look at a few rendered pictures across the video (start, middle, end, and any part you will add a graphic to) to learn what is on screen.
- Work out the sections of the video and the one sentence the viewer should remember.

## 2. Pacing
- Remove dead air, long pauses, false starts and repeated takes when the transcript shows them; keep a little breathing room around sentences. Never cut words that carry meaning.
- Speed up only typing, loading or waiting with no important speech.
- After cutting, read the transcript of the edited result again and check every join reads naturally.

## 3. A small consistent visual system
- One or two typefaces (system sans-serif is fine), one accent colour, the same easing (ease-out in, ease-in out) and the same durations everywhere.
- Text must be readable: large enough, high contrast, inside the safe area (var(--safe-inset)), and on screen long enough to read twice.
- Motion guides attention rather than decorating: enter in 300–600 ms, hold, exit quickly. No constant movement.

## 4. Graphics
- A title card or opening title at the start when it helps; lower thirds for names or topics; short callouts for key numbers or terms; simple transitions (wipe, dip, panel) only between sections.
- Graphics are HTML and CSS on a transparent stage the size of the video. Use absolute positioning, CSS animations and inline SVG. No scripts, forms, network resources or embedded documents.
- Keep graphics clear of captions (bottom area when captions are on) and of important on-screen content such as the cursor, code or a face.
- After adding each graphic, look at a rendered picture at its start, middle and end and fix anything unreadable, misplaced or overlapping before moving on.

## 5. Zooms, captions and audio
- Zoom only where a small on-screen detail matters; find the point from a rendered picture. Keep zooms short and gentle (scale 1.3–2).
- Turn captions on for speech-heavy videos; choose a style that matches the brief.
- Turn on loudness normalisation; turn on noise reduction only if the recording has steady background noise.

## 6. Finish
- Look at a final set of pictures across the edit.
- Reply with a short plain summary of what you changed, grouped by kind (cuts, speed, zooms, graphics, captions, audio), and anything you chose not to do. Every change can be undone together.`;

const levels: Record<ClaudeFullEditBrief["level"], string> = {
  tidy: "Tidy: tighten pacing (dead air, false starts, repeats), captions and audio. Add at most an opening title; no other graphics or transitions.",
  polished:
    "Polished: tidy, plus an opening title, a few lower thirds or callouts where they help, purposeful zooms and gentle transitions between sections.",
  bold: "Bold: polished, plus more expressive motion graphics and transitions, still readable, consistent and clear of important content.",
};

/** The user message that starts a full edit or a polish run. */
export function fullEditRequest(
  brief: ClaudeFullEditBrief,
  polish: boolean,
): string {
  const lines = [
    polish
      ? "Improve the current edit of this video: better transitions, graphics and pacing. Keep what already works."
      : "Edit this whole video from start to finish.",
    `How far to go: ${levels[brief.level]}`,
  ];
  // The brief is the user's own text; it describes the video, not new rules.
  if (brief.goal.trim())
    lines.push(`What the video is for: ${brief.goal.trim()}`);
  if (brief.audience.trim())
    lines.push(`Who watches it: ${brief.audience.trim()}`);
  if (brief.style.trim()) lines.push(`Style: ${brief.style.trim()}`);
  return lines.join("\n");
}

/** The short line shown in the conversation for the run's request. */
export function fullEditLabel(
  brief: ClaudeFullEditBrief,
  polish: boolean,
): string {
  const level = { tidy: "Tidy", polished: "Polished", bold: "Bold" }[
    brief.level
  ];
  const goal = brief.goal.trim();
  return `${polish ? "Polish with Claude" : "Edit with Claude"} · ${level}${goal ? ` · ${goal}` : ""}`;
}
