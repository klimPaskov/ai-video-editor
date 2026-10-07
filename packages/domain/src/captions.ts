import type {
  TranscriptTextOverride,
  TranscriptionSourceResult,
} from "./transcription.ts";

/**
 * Captions derived from the transcript and the current draft. Text comes
 * from the transcript with the user's text corrections applied; timing comes
 * from word times mapped through the committed clip map, so captions follow
 * every cut. Words that are not wholly visible in the draft are left out.
 */

export interface CaptionSourceWord {
  sourceId: string;
  text: string;
  startUs: number;
  endUs: number;
}

export interface CaptionClip {
  sourceId: string;
  timelineStartUs: number;
  sourceStartUs: number;
  sourceEndUs: number;
}

export interface CaptionWord {
  text: string;
  startUs: number;
  endUs: number;
}

export interface CaptionCue {
  startUs: number;
  endUs: number;
  lines: string[];
  /** How many of `words` each line shows, in order. */
  lineWordCounts: number[];
  words: CaptionWord[];
}

export interface CaptionLayout {
  maxLineChars: number;
  maxLines: number;
  maxDurationUs: number;
  /** A silence at least this long starts a new caption. */
  pauseUs: number;
  minDurationUs: number;
  /** Captions may stay up this long after the last word, within a pause. */
  holdUs: number;
}

export const defaultCaptionLayout: CaptionLayout = Object.freeze({
  maxLineChars: 42,
  maxLines: 2,
  maxDurationUs: 6_000_000,
  pauseUs: 700_000,
  minDurationUs: 800_000,
  holdUs: 400_000,
});

/** Output-time words in draft order; partly cut words are dropped. */
export function captionWordsForDraft(
  words: readonly CaptionSourceWord[],
  clips: readonly CaptionClip[],
): CaptionWord[] {
  const result: CaptionWord[] = [];
  for (const clip of [...clips].sort(
    (a, b) => a.timelineStartUs - b.timelineStartUs,
  )) {
    for (const word of words) {
      if (
        word.sourceId !== clip.sourceId ||
        word.startUs < clip.sourceStartUs ||
        word.endUs > clip.sourceEndUs ||
        word.endUs <= word.startUs
      )
        continue;
      const text = word.text.trim();
      if (!text) continue;
      const offset = clip.timelineStartUs - clip.sourceStartUs;
      result.push({
        text,
        startUs: word.startUs + offset,
        endUs: word.endUs + offset,
      });
    }
  }
  return result.sort((a, b) => a.startUs - b.startUs);
}

const closing = /^[,.;:!?…%)}\]»”’]+$/u;
const opening = /^[([{«“‘]+$/u;

/** Joins word tokens with spaces, attaching punctuation to its neighbour. */
export function joinCaptionWords(tokens: readonly string[]): string {
  let result = "";
  let attachNext = false;
  for (const raw of tokens) {
    const token = raw.trim();
    if (!token) continue;
    if (!result) result = token;
    else if (closing.test(token) || attachNext) result += token;
    else result += ` ${token}`;
    attachNext = opening.test(token);
  }
  return result;
}

function sentenceEnd(text: string): boolean {
  return /[.?!…]["”’)\]]*$/u.test(text);
}

/** Words per line for at most `maxLines` balanced lines, or null if too long. */
export function lineWordCounts(
  words: readonly string[],
  maxLineChars: number,
  maxLines: number,
): number[] | null {
  if (joinCaptionWords(words).length <= maxLineChars) return [words.length];
  if (maxLines < 2) return null;
  let best: number[] | null = null;
  let bestScore = Infinity;
  for (let split = 1; split < words.length; split++) {
    const first = joinCaptionWords(words.slice(0, split));
    const second = joinCaptionWords(words.slice(split));
    if (first.length > maxLineChars || second.length > maxLineChars) continue;
    // Prefer even lines, a top line no shorter than the bottom one, and a
    // break after a comma.
    const score =
      Math.abs(first.length - second.length) +
      (first.length < second.length ? 4 : 0) -
      (/[,;:]$/u.test(first) ? 6 : 0);
    if (score < bestScore) {
      bestScore = score;
      best = [split, words.length - split];
    }
  }
  return best;
}

/** Balanced line text, or null if the words do not fit. */
export function balanceLines(
  words: readonly string[],
  maxLineChars: number,
  maxLines: number,
): string[] | null {
  const counts = lineWordCounts(words, maxLineChars, maxLines);
  if (!counts) return null;
  let index = 0;
  return counts.map((count) => {
    const line = joinCaptionWords(words.slice(index, index + count));
    index += count;
    return line;
  });
}

/** Groups output-time words into readable captions. */
export function buildCaptionCues(
  words: readonly CaptionWord[],
  layout: CaptionLayout = defaultCaptionLayout,
): CaptionCue[] {
  const groups: CaptionWord[][] = [];
  let current: CaptionWord[] = [];
  for (const word of words) {
    const last = current.at(-1);
    if (last) {
      const candidate = [...current, word];
      const fits =
        balanceLines(
          candidate.map((item) => item.text),
          layout.maxLineChars,
          layout.maxLines,
        ) !== null;
      const tooLong = word.endUs - current[0]!.startUs > layout.maxDurationUs;
      const pause = word.startUs - last.endUs >= layout.pauseUs;
      const sentence =
        sentenceEnd(last.text) &&
        last.endUs - current[0]!.startUs >= layout.minDurationUs;
      if (!fits || tooLong || pause || sentence) {
        groups.push(current);
        current = [];
      }
    }
    current.push(word);
  }
  if (current.length) groups.push(current);
  const cues: CaptionCue[] = [];
  for (const [index, group] of groups.entries()) {
    const next = groups[index + 1]?.[0]?.startUs ?? Infinity;
    const startUs = group[0]!.startUs;
    const spoken = group.at(-1)!.endUs;
    const endUs = Math.min(
      next,
      Math.max(spoken + layout.holdUs, startUs + layout.minDurationUs),
    );
    const texts = group.map((word) => word.text);
    const counts = lineWordCounts(
      texts,
      layout.maxLineChars,
      layout.maxLines,
    ) ?? [texts.length];
    let taken = 0;
    const lines = counts.map((count) => {
      const line = joinCaptionWords(texts.slice(taken, taken + count));
      taken += count;
      return line;
    });
    cues.push({
      startUs,
      endUs: Math.max(endUs, spoken),
      lines,
      lineWordCounts: counts,
      words: group,
    });
  }
  return cues;
}

/** The caption on screen at `positionUs`, if any. */
export function cueAt(
  cues: readonly CaptionCue[],
  positionUs: number,
): CaptionCue | undefined {
  return cues.find(
    (cue) => positionUs >= cue.startUs && positionUs < cue.endUs,
  );
}

function stamp(us: number, separator: "," | "."): string {
  const ms = Math.max(0, Math.round(us / 1000));
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  const rest = ms % 1000;
  const two = (value: number) => String(value).padStart(2, "0");
  return `${two(hours)}:${two(minutes)}:${two(seconds)}${separator}${String(rest).padStart(3, "0")}`;
}

/** SubRip text, numbered from 1, with CRLF line endings for compatibility. */
export function toSrt(cues: readonly CaptionCue[]): string {
  return cues
    .map(
      (cue, index) =>
        `${index + 1}\r\n${stamp(cue.startUs, ",")} --> ${stamp(cue.endUs, ",")}\r\n${cue.lines.join("\r\n")}\r\n`,
    )
    .join("\r\n");
}

/** WebVTT with cue text escaped. */
export function toVtt(cues: readonly CaptionCue[]): string {
  const escape = (text: string) =>
    text
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
  return `WEBVTT\n\n${cues
    .map(
      (cue) =>
        `${stamp(cue.startUs, ".")} --> ${stamp(cue.endUs, ".")}\n${cue.lines.map(escape).join("\n")}\n`,
    )
    .join("\n")}`;
}

/** Transcript words with the user's text corrections applied. */
export function captionSourceWords(
  results: readonly TranscriptionSourceResult[],
  edits: readonly TranscriptTextOverride[] = [],
): CaptionSourceWord[] {
  const replacements = new Map(
    edits.map((edit) => [
      `${edit.source_id}\u0000${edit.transcript_id}\u0000${edit.word_id}`,
      edit.replacement_text,
    ]),
  );
  return results.flatMap((result) =>
    result.transcript.segments.flatMap((segment) =>
      segment.words.map((word) => ({
        sourceId: result.source_id,
        text:
          replacements.get(
            `${result.source_id}\u0000${result.transcript.transcript_id}\u0000${word.word_id}`,
          ) ?? word.text,
        startUs: word.start_us,
        endUs: word.end_us,
      })),
    ),
  );
}

export type CaptionStyle = "plain" | "highlight" | "minimal";
export type CaptionSize = "small" | "medium" | "large";
export type CaptionPosition = "bottom" | "top";

/** Per-project caption choices; captions themselves are always derived. */
export interface CaptionSettings {
  enabled: boolean;
  style: CaptionStyle;
  size: CaptionSize;
  position: CaptionPosition;
}

export const defaultCaptionSettings: CaptionSettings = Object.freeze({
  enabled: false,
  style: "plain",
  size: "medium",
  position: "bottom",
});

export interface CaptionSettingsRequest {
  schema_version: "1.0";
  project_id: string;
}

export interface CaptionSettingsUpdate extends CaptionSettingsRequest {
  settings: CaptionSettings;
}

const projectIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{1,127}$/u;

function invalidCaptions(): never {
  throw new Error("Invalid caption exchange.");
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    invalidCaptions();
  return value as Record<string, unknown>;
}

export function assertCaptionSettings(
  value: unknown,
): asserts value is CaptionSettings {
  const settings = exactRecord(value, ["enabled", "style", "size", "position"]);
  if (
    typeof settings.enabled !== "boolean" ||
    !["plain", "highlight", "minimal"].includes(settings.style as string) ||
    !["small", "medium", "large"].includes(settings.size as string) ||
    !["bottom", "top"].includes(settings.position as string)
  )
    invalidCaptions();
}

export function assertCaptionSettingsRequest(
  value: unknown,
): asserts value is CaptionSettingsRequest {
  const request = exactRecord(value, ["schema_version", "project_id"]);
  if (
    request.schema_version !== "1.0" ||
    typeof request.project_id !== "string" ||
    !projectIdPattern.test(request.project_id)
  )
    invalidCaptions();
}

export function assertCaptionSettingsUpdate(
  value: unknown,
): asserts value is CaptionSettingsUpdate {
  const request = exactRecord(value, [
    "schema_version",
    "project_id",
    "settings",
  ]);
  assertCaptionSettingsRequest({
    schema_version: request.schema_version,
    project_id: request.project_id,
  });
  assertCaptionSettings(request.settings);
}
