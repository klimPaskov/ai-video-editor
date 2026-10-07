import type {
  LocalTranscript,
  TranscriptAnalysis,
  TranscriptWord,
} from "./transcription.ts";
import type { SpokenCandidateReport } from "./spoken-candidates.ts";

/**
 * Deterministic Magic Edit first cut. It turns only low-risk local evidence
 * into cuts: detected silence longer than the preset (keeping breathing
 * room), isolated configured fillers with clean gaps on both sides, and the
 * earlier copy of an exactly repeated sentence (the final take is kept).
 * Anything touching a protected or uncertain word, false starts,
 * self-corrections and spoken editor cues stay for review.
 */

export const magicWandPresets = ["gentle", "balanced", "tight"] as const;
export type MagicWandPreset = (typeof magicWandPresets)[number];

export interface MagicWandPresetConfig {
  /** Shortest word-free silence that is shortened. */
  minimumPauseUs: number;
  /** Silence kept at a shortened pause, split across both sides. */
  keptPauseUs: number;
  removeFillers: boolean;
  removeRepeatedTakes: boolean;
}

export const magicWandPresetConfigs: Readonly<
  Record<MagicWandPreset, Readonly<MagicWandPresetConfig>>
> = Object.freeze({
  gentle: Object.freeze({
    minimumPauseUs: 2_000_000,
    keptPauseUs: 800_000,
    removeFillers: false,
    removeRepeatedTakes: true,
  }),
  balanced: Object.freeze({
    minimumPauseUs: 1_000_000,
    keptPauseUs: 500_000,
    removeFillers: true,
    removeRepeatedTakes: true,
  }),
  tight: Object.freeze({
    minimumPauseUs: 600_000,
    keptPauseUs: 300_000,
    removeFillers: true,
    removeRepeatedTakes: true,
  }),
});

/** A word must have at least this much non-speech on each side to be lifted out. */
export const minimumCleanGapUs = 40_000;
/** Fillers recognised with lower confidence are left for review. */
export const minimumFillerConfidence = 0.5;

export type MagicCutKind = "pause" | "filler" | "repeated_take";

export interface MagicSourceInput {
  sourceId: string;
  transcript: LocalTranscript;
  analysis: TranscriptAnalysis;
  report: SpokenCandidateReport;
}

export interface MagicCut {
  sourceId: string;
  startUs: number;
  endUs: number;
  kinds: MagicCutKind[];
}

export interface MagicPlan {
  cuts: MagicCut[];
  /** Candidates found but not cut automatically. */
  leftForReview: number;
}

const blockingFlags = new Set([
  "uncertain",
  "protected",
  "name",
  "number",
  "negation",
  "overlap",
]);

interface Word extends TranscriptWord {
  index: number;
}

function sourceWords(transcript: LocalTranscript): Word[] {
  return transcript.segments
    .flatMap((segment) => segment.words)
    .map((word, index) => ({ ...word, index }))
    .sort((a, b) => a.start_us - b.start_us || a.end_us - b.end_us);
}

/** Plans the cuts for every source; ranges are source time, half-open. */
export function planMagicWandCuts(
  sources: readonly MagicSourceInput[],
  preset: MagicWandPreset,
): MagicPlan {
  const config = magicWandPresetConfigs[preset];
  const cuts: MagicCut[] = [];
  let leftForReview = 0;
  for (const source of sources) {
    const { transcript, analysis, report } = source;
    if (
      transcript.source_id !== source.sourceId ||
      analysis.source_id !== source.sourceId ||
      report.source_id !== source.sourceId ||
      report.transcript_id !== transcript.transcript_id
    )
      throw new Error("Magic Edit inputs do not belong to the same source.");
    const words = sourceWords(transcript);
    const protectedIds = new Set(
      report.protected_words.map((item) => item.word_id),
    );
    const blocked = (word: TranscriptWord) =>
      protectedIds.has(word.word_id) ||
      (word.flags ?? []).some((flag) => blockingFlags.has(flag));
    const byId = new Map(words.map((word) => [word.word_id, word]));
    const sourceCuts: MagicCut[] = [];
    const add = (startUs: number, endUs: number, kind: MagicCutKind) => {
      const start = Math.max(0, Math.round(startUs));
      const end = Math.min(transcript.duration_us, Math.round(endUs));
      if (end - start >= 10_000)
        sourceCuts.push({
          sourceId: source.sourceId,
          startUs: start,
          endUs: end,
          kinds: [kind],
        });
    };
    /** Gap before/after a run of words, bounded by neighbours or the source. */
    const gaps = (first: Word, last: Word) => {
      const before = words
        .filter((word) => word.end_us <= first.start_us && word !== first)
        .at(-1);
      const after = words.find(
        (word) => word.start_us >= last.end_us && word !== last,
      );
      return {
        before: first.start_us - (before?.end_us ?? 0),
        after: (after?.start_us ?? transcript.duration_us) - last.end_us,
      };
    };

    // Pauses: word-free detected silence longer than the preset.
    for (const silence of analysis.silences) {
      let start = silence.start_us;
      let end = silence.end_us;
      for (const word of words) {
        if (word.end_us <= start || word.start_us >= end) continue;
        // A word inside the silence splits it; keep the larger free side.
        if (word.start_us - start >= end - word.end_us) end = word.start_us;
        else start = word.end_us;
      }
      if (end - start < config.minimumPauseUs) continue;
      add(
        start + config.keptPauseUs / 2,
        end - config.keptPauseUs / 2,
        "pause",
      );
    }

    for (const candidate of report.candidates) {
      if (candidate.disposition !== "review_required") continue;
      if (candidate.kind === "filler" && config.removeFillers) {
        const word =
          candidate.word_ids.length === 1
            ? byId.get(candidate.word_ids[0]!)
            : undefined;
        const gap = word ? gaps(word, word) : null;
        if (
          !word ||
          !gap ||
          blocked(word) ||
          (typeof word.confidence === "number" &&
            word.confidence < minimumFillerConfidence) ||
          gap.before < minimumCleanGapUs ||
          gap.after < minimumCleanGapUs
        ) {
          leftForReview++;
          continue;
        }
        add(
          word.start_us - gap.before / 2,
          word.end_us + gap.after / 2,
          "filler",
        );
        continue;
      }
      if (
        candidate.kind === "repeated_take" &&
        config.removeRepeatedTakes &&
        candidate.related_segment_id
      ) {
        const earlier = transcript.segments.find(
          (segment) => segment.segment_id === candidate.related_segment_id,
        );
        const earlierWords = (earlier?.words ?? [])
          .map((word) => byId.get(word.word_id))
          .filter((word): word is Word => Boolean(word));
        const first = earlierWords[0];
        const last = earlierWords.at(-1);
        const gap = first && last ? gaps(first, last) : null;
        if (
          !first ||
          !last ||
          !gap ||
          earlierWords.some(blocked) ||
          gap.before < minimumCleanGapUs ||
          gap.after < minimumCleanGapUs ||
          last.end_us > candidate.source_start_us
        ) {
          leftForReview++;
          continue;
        }
        add(
          first.start_us - gap.before / 2,
          last.end_us + gap.after / 2,
          "repeated_take",
        );
        continue;
      }
      leftForReview++;
    }

    // A cut may never remove part of a word it was not meant to remove.
    const safe = sourceCuts.filter((cut) =>
      words.every((word) => {
        const overlaps = word.start_us < cut.endUs && word.end_us > cut.startUs;
        if (!overlaps) return true;
        const inside = word.start_us >= cut.startUs && word.end_us <= cut.endUs;
        return inside && !blocked(word) && !cut.kinds.includes("pause");
      }),
    );
    leftForReview += sourceCuts.length - safe.length;
    cuts.push(...mergeCuts(safe));
  }
  return { cuts, leftForReview };
}

/** Merges overlapping or touching cuts of one source, keeping their kinds. */
export function mergeCuts(cuts: readonly MagicCut[]): MagicCut[] {
  const sorted = [...cuts].sort((a, b) => a.startUs - b.startUs);
  const merged: MagicCut[] = [];
  for (const cut of sorted) {
    const last = merged.at(-1);
    if (last && last.sourceId === cut.sourceId && cut.startUs <= last.endUs) {
      last.endUs = Math.max(last.endUs, cut.endUs);
      for (const kind of cut.kinds)
        if (!last.kinds.includes(kind)) last.kinds.push(kind);
    } else merged.push({ ...cut, kinds: [...cut.kinds] });
  }
  return merged;
}

export interface MagicClip {
  source_id: string;
  source_start_us: number;
  source_end_us: number;
  timeline_start_us: number;
  timeline_end_us: number;
}

export interface OutputCut {
  start_us: number;
  end_us: number;
  kinds: MagicCutKind[];
}

/**
 * Maps source-time cuts onto the current draft's output time. Material
 * already removed maps to nothing; a cut spanning several visible pieces
 * maps to each. Result is sorted latest first, ready for ripple deletes.
 */
export function mapCutsToOutput(
  cuts: readonly MagicCut[],
  clips: readonly MagicClip[],
): OutputCut[] {
  const output: OutputCut[] = [];
  for (const cut of cuts)
    for (const clip of clips) {
      if (clip.source_id !== cut.sourceId) continue;
      const start = Math.max(cut.startUs, clip.source_start_us);
      const end = Math.min(cut.endUs, clip.source_end_us);
      if (end <= start) continue;
      output.push({
        start_us: clip.timeline_start_us + (start - clip.source_start_us),
        end_us: clip.timeline_start_us + (end - clip.source_start_us),
        kinds: [...cut.kinds],
      });
    }
  output.sort((a, b) => a.start_us - b.start_us);
  const merged: OutputCut[] = [];
  for (const range of output) {
    const last = merged.at(-1);
    if (last && range.start_us <= last.end_us) {
      last.end_us = Math.max(last.end_us, range.end_us);
      for (const kind of range.kinds)
        if (!last.kinds.includes(kind)) last.kinds.push(kind);
    } else merged.push(range);
  }
  return merged.reverse();
}
