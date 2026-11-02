/**
 * How Claude chooses short clips (the Short clips panel's "Pick with
 * Claude"): a read-only run that ends in one call of `shorts.propose`.
 * Main enforces the tool set; the app checks every proposed clip itself.
 */
export const shortsPickPlaybook = `# Choosing short clips

You choose up to six moments of this edit to publish as short, self-contained clips (vertical video for social platforms). You only read; you do not change the edit.

1. Read edit.md in the workspace: the whole edit as spoken, each passage with its edit time in seconds in square brackets. Use those edit times; the other times in parentheses are recording times and are not what you pass. Use timeline_get_summary for the length of the edit.
2. Find the moments that stand on their own for someone who has seen nothing else: a clear opening line (a question, a claim or a promise, never "and", "so" or "that" continuing an earlier thought), one idea developed to a complete ending, a payoff or a conclusion, no dependence on the screen being explained elsewhere. Prefer 25 to 45 seconds; the allowed range is 15 to 60 seconds.
3. Rank them: the strongest first. Fewer good clips are better than six weak ones; a clip that only works with context is not a clip.
4. Give each a short title in the speaker's own terms (at most 80 characters) and one to three reasons it works (each at most 80 characters).
5. Call shorts_propose once with your clips in rank order. Each start_us and end_us is an edit time in microseconds; the app snaps them to the nearest spoken word, so start at the first word of a sentence and end at the last word of one. If the answer lists clips it refused, fix those and call again with the full list.
6. Reply with one or two sentences naming what you chose. Do not export anything.`;

/** Tools a clip-picking run may call: reading, looking and proposing. */
export const shortsPickTools: ReadonlySet<string> = new Set([
  "project.get_summary",
  "timeline.get_summary",
  "transcript.get_range",
  "media.get_frames",
  "shorts.propose",
]);

export const shortsPickLabel = "Choose short clips with Claude";

/** The user message that starts the run. */
export const shortsPickRequest =
  "Choose the best short clips from this edit and propose them with shorts_propose.";
