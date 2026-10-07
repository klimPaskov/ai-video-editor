import { joinCaptionWords, type CaptionWord } from "./captions.ts";

/**
 * Short clips from a finished draft. Candidates are found locally from the
 * draft's transcript (output time): each starts at a sentence and ends at
 * the end of one, stays within the length range, and is scored on whether
 * it stands on its own. These are suggestions from simple transcript rules,
 * not AI judgments; the user previews, discards or exports them.
 */

export type ShortFormat = "vertical" | "square" | "landscape";
export type ShortFraming = "fit" | "fill";

export interface ShortCandidate {
  id: string;
  title: string;
  startUs: number;
  endUs: number;
  /** 0..1; higher stands better on its own. */
  score: number;
  reasons: string[];
  excerpt: string;
}

export interface ShortFindOptions {
  minUs: number;
  maxUs: number;
  /** Preferred length range; scores fall off outside it. */
  idealMinUs: number;
  idealMaxUs: number;
  maxClips: number;
  minScore: number;
  /** A silence this long also ends a sentence. */
  sentencePauseUs: number;
}

export const defaultShortFindOptions: ShortFindOptions = Object.freeze({
  minUs: 15_000_000,
  maxUs: 60_000_000,
  idealMinUs: 25_000_000,
  idealMaxUs: 45_000_000,
  maxClips: 6,
  minScore: 0.55,
  sentencePauseUs: 1_200_000,
});

interface Sentence {
  words: CaptionWord[];
  startUs: number;
  endUs: number;
  text: string;
  complete: boolean;
  /** Begins a sentence (not the rest of one split by a pause). */
  cleanStart: boolean;
}

const terminal = /[.?!…]["”’)\]]*$/u;
/** Openings that usually depend on something said before. */
const dependentOpening = new Set([
  "and",
  "but",
  "so",
  "because",
  "which",
  "that",
  "this",
  "these",
  "those",
  "it",
  "it's",
  "they",
  "them",
  "he",
  "she",
  "then",
  "or",
  "plus",
  "however",
  "therefore",
  "otherwise",
]);
/** Discourse openers that often start a story; only mildly penalised. */
const softOpening = new Set(["so", "also", "anyway", "well", "okay", "ok"]);
const hookOpening = new Set([
  "how",
  "why",
  "what",
  "here's",
  "here",
  "the",
  "if",
  "when",
  "never",
  "always",
  "stop",
  "most",
  "everyone",
]);
const fillers = new Set(["um", "uh", "erm", "uhm", "hmm", "mm"]);

function bare(text: string): string {
  return text
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, "")
    .replaceAll("’", "'");
}

export function splitSentences(
  words: readonly CaptionWord[],
  pauseUs = defaultShortFindOptions.sentencePauseUs,
): Sentence[] {
  const sentences: Sentence[] = [];
  let current: CaptionWord[] = [];
  const close = (complete: boolean) => {
    if (!current.length) return;
    sentences.push({
      words: current,
      startUs: current[0]!.startUs,
      endUs: current.at(-1)!.endUs,
      text: joinCaptionWords(current.map((word) => word.text)),
      complete,
      cleanStart: sentences.length === 0 || sentences.at(-1)!.complete,
    });
    current = [];
  };
  for (const word of words) {
    const last = current.at(-1);
    if (last && word.startUs - last.endUs >= pauseUs) close(false);
    current.push(word);
    if (terminal.test(word.text)) close(true);
  }
  close(false);
  return sentences;
}

function scoreWindow(
  sentences: readonly Sentence[],
  options: ShortFindOptions,
): { score: number; reasons: string[] } {
  const first = sentences[0]!;
  const last = sentences.at(-1)!;
  const words = sentences.flatMap((sentence) => sentence.words);
  const durationUs = last.endUs - first.startUs;
  const reasons: string[] = [];
  let score = 0.5;
  const opening = bare(first.words[0]!.text);
  if (dependentOpening.has(opening)) score -= 0.3;
  else if (softOpening.has(opening)) score -= 0.05;
  else {
    score += 0.1;
    reasons.push("Clean opening");
  }
  if (first.text.trim().endsWith("?")) {
    score += 0.12;
    reasons.push("Opens with a question");
  } else if (hookOpening.has(opening)) score += 0.05;
  if (last.complete) {
    score += 0.15;
    reasons.push("Ends on a complete sentence");
  } else score -= 0.2;
  if (durationUs >= options.idealMinUs && durationUs <= options.idealMaxUs)
    score += 0.1;
  else {
    const off =
      durationUs < options.idealMinUs
        ? options.idealMinUs - durationUs
        : durationUs - options.idealMaxUs;
    score -= Math.min(0.15, (off / 15_000_000) * 0.15);
  }
  // Steady speech: few long silences and few fillers.
  let silenceUs = 0;
  for (let index = 1; index < words.length; index++) {
    const gap = words[index]!.startUs - words[index - 1]!.endUs;
    if (gap > 700_000) silenceUs += gap;
  }
  const silenceShare = silenceUs / Math.max(1, durationUs);
  const fillerShare =
    words.filter((word) => fillers.has(bare(word.text))).length /
    Math.max(1, words.length);
  if (silenceShare < 0.1 && fillerShare < 0.02) {
    score += 0.08;
    reasons.push("Steady speech");
  } else score -= Math.min(0.2, silenceShare * 0.6 + fillerShare * 3);
  const wordsPerSecond = words.length / Math.max(1, durationUs / 1_000_000);
  if (wordsPerSecond < 1.2) score -= 0.1;
  return {
    score: Math.max(0, Math.min(1, Math.round(score * 1000) / 1000)),
    reasons,
  };
}

function titleOf(sentence: Sentence): string {
  const text = sentence.text.replace(/\s+/gu, " ").trim();
  if (text.length <= 60) return text;
  const cut = text.slice(0, 58);
  return `${cut.slice(0, Math.max(20, cut.lastIndexOf(" ")))}…`;
}

function excerptOf(sentences: readonly Sentence[]): string {
  const text = sentences
    .map((sentence) => sentence.text)
    .join(" ")
    .trim();
  return text.length <= 220
    ? text
    : `${text.slice(0, Math.max(120, text.slice(0, 218).lastIndexOf(" ")))}…`;
}

/** Best non-overlapping self-contained moments, in time order. */
export function findShortCandidates(
  words: readonly CaptionWord[],
  options: ShortFindOptions = defaultShortFindOptions,
): ShortCandidate[] {
  const sentences = splitSentences(words, options.sentencePauseUs);
  const windows: (ShortCandidate & { from: number; to: number })[] = [];
  for (let from = 0; from < sentences.length; from++) {
    // A clip starts where a sentence starts, never mid-sentence.
    if (!sentences[from]!.cleanStart) continue;
    for (let to = from; to < sentences.length; to++) {
      const startUs = sentences[from]!.startUs;
      const endUs = sentences[to]!.endUs;
      const durationUs = endUs - startUs;
      if (durationUs > options.maxUs) break;
      if (durationUs < options.minUs) continue;
      const chosen = sentences.slice(from, to + 1);
      const { score, reasons } = scoreWindow(chosen, options);
      if (score < options.minScore) continue;
      windows.push({
        id: `clip-${startUs}-${endUs}`,
        title: titleOf(chosen[0]!),
        startUs,
        endUs,
        score,
        reasons,
        excerpt: excerptOf(chosen),
        from,
        to,
      });
    }
  }
  windows.sort((a, b) => b.score - a.score || a.startUs - b.startUs);
  const picked: typeof windows = [];
  for (const window of windows) {
    if (picked.length >= options.maxClips) break;
    if (
      picked.some(
        (other) => window.startUs < other.endUs && other.startUs < window.endUs,
      )
    )
      continue;
    picked.push(window);
  }
  return picked
    .sort((a, b) => a.startUs - b.startUs)
    .map((window) => ({
      id: window.id,
      title: window.title,
      startUs: window.startUs,
      endUs: window.endUs,
      score: window.score,
      reasons: window.reasons,
      excerpt: window.excerpt,
    }));
}

/** Output size for a short; dimensions are even for 4:2:0 encoding. */
export function shortSize(format: ShortFormat): {
  width: number;
  height: number;
} {
  return format === "vertical"
    ? { width: 1080, height: 1920 }
    : format === "square"
      ? { width: 1080, height: 1080 }
      : { width: 1920, height: 1080 };
}

/**
 * FFmpeg filter that reframes draft frames for a short. "fit" shows the
 * whole frame over a blurred, darkened fill of itself (good for screen
 * recordings); "fill" crops to the format at `position` (0 left/top, 1
 * right/bottom). The result is 4:2:0 at the short's size.
 */
export function reframeFilter(
  format: ShortFormat,
  framing: ShortFraming,
  position = 0.5,
): string {
  const { width, height } = shortSize(format);
  const at = Math.min(1, Math.max(0, position)).toFixed(4);
  if (framing === "fill")
    return [
      `scale=${width}:${height}:force_original_aspect_ratio=increase:flags=lanczos`,
      `crop=${width}:${height}:(iw-ow)*${at}:(ih-oh)*${at}`,
      "setsar=1",
    ].join(",");
  return [
    "split=2[base][front]",
    `[base]scale=${width}:${height}:force_original_aspect_ratio=increase:flags=bilinear,crop=${width}:${height},gblur=sigma=28,eq=brightness=-0.12[back]`,
    `[front]scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=lanczos[fore]`,
    "[back][fore]overlay=(W-w)/2:(H-h)/2,setsar=1",
  ].join(";");
}

/** Draft words inside a short, shifted to start at zero. */
export function shortWords(
  words: readonly CaptionWord[],
  startUs: number,
  endUs: number,
): CaptionWord[] {
  return words
    .filter((word) => word.startUs >= startUs && word.endUs <= endUs)
    .map((word) => ({
      text: word.text,
      startUs: word.startUs - startUs,
      endUs: word.endUs - startUs,
    }));
}

export interface DraftClipRange {
  sourceId: string;
  timelineStartUs: number;
  timelineEndUs: number;
  sourceStartUs: number;
  sourceEndUs: number;
}

/** Source ranges that make up output time [startUs, endUs) of the draft. */
export function draftWindowClips(
  clips: readonly DraftClipRange[],
  startUs: number,
  endUs: number,
): { sourceId: string; sourceStartUs: number; sourceEndUs: number }[] {
  const ranges: {
    sourceId: string;
    sourceStartUs: number;
    sourceEndUs: number;
  }[] = [];
  for (const clip of [...clips].sort(
    (a, b) => a.timelineStartUs - b.timelineStartUs,
  )) {
    const from = Math.max(startUs, clip.timelineStartUs);
    const to = Math.min(endUs, clip.timelineEndUs);
    if (to <= from) continue;
    const offset = clip.sourceStartUs - clip.timelineStartUs;
    ranges.push({
      sourceId: clip.sourceId,
      sourceStartUs: from + offset,
      sourceEndUs: to + offset,
    });
  }
  return ranges;
}
