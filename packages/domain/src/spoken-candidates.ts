/** Analysis-only speech candidates. These records never authorize a cut. */
import type {
  LocalTranscript,
  TranscriptAnalysis,
  TranscriptWord,
} from "./transcription.ts";
import {
  assertLocalTranscript,
  assertTranscriptAnalysis,
} from "./transcription.ts";

export const spokenCandidateSchemaVersion = "1.0" as const;

export const spokenCandidateKinds = [
  "filler",
  "false_start",
  "repeated_take",
  "self_correction",
  "editor_cue",
  "long_pause",
] as const;
export type SpokenCandidateKind = (typeof spokenCandidateKinds)[number];

export const spokenCandidateDispositions = [
  "review_required",
  "context_only",
  "protected",
] as const;
export type SpokenCandidateDisposition =
  (typeof spokenCandidateDispositions)[number];

export const spokenCandidateEvidenceCodes = [
  "configured_filler_cue",
  "exact_repeated_segment",
  "disfluent_restart",
  "self_correction_marker",
  "configured_editor_cue",
  "opted_in_legacy_cue",
  "quoted_editor_cue",
  "quoted_filler",
  "quoted_speech_context",
  "long_silence_context",
] as const;
export type SpokenCandidateEvidenceCode =
  (typeof spokenCandidateEvidenceCodes)[number];

export const protectedSpeechReasons = [
  "manual",
  "sponsor",
  "licensed",
  "uncertain",
  "name",
  "number",
  "negation",
  "protected",
  "overlap",
] as const;
export type ProtectedSpeechReason = (typeof protectedSpeechReasons)[number];

export interface SpokenProtectedRange {
  start_us: number;
  end_us: number;
  reason: "manual" | "sponsor" | "licensed";
}

export interface SpokenCandidatePolicy {
  schema_version: typeof spokenCandidateSchemaVersion;
  /** Null means the transcript language is not known well enough for cue matching. */
  cue_language: string | null;
  filler_cues: string[];
  editor_cue: string;
  legacy_editor_cues: string[];
  legacy_aliases_enabled: boolean;
  /** Review cue only; this duration never authorizes a cut. */
  pause_review_threshold_us: number;
  protected_word_ids: string[];
  protected_ranges: SpokenProtectedRange[];
}

export interface SpokenCandidate {
  candidate_id: string;
  kind: SpokenCandidateKind;
  disposition: SpokenCandidateDisposition;
  source_start_us: number;
  source_end_us: number;
  start_word_id: string | null;
  end_word_id: string | null;
  word_ids: string[];
  related_segment_id: string | null;
  protected_word_ids: string[];
  protected_reasons: ProtectedSpeechReason[];
  evidence: SpokenCandidateEvidenceCode[];
  cut_authorized: false;
}

export interface SpokenProtectedWord {
  word_id: string;
  reasons: ProtectedSpeechReason[];
}

export interface SpokenCandidateReport {
  schema_version: typeof spokenCandidateSchemaVersion;
  project_id: string;
  source_id: string;
  transcript_id: string;
  source_sha256: string;
  duration_us: number;
  language: string;
  authority: "analysis_only";
  candidates: SpokenCandidate[];
  protected_words: SpokenProtectedWord[];
  warnings: string[];
}

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{1,127}$/u;
const hashPattern = /^[a-f0-9]{64}$/u;
const warningCodes = new Set([
  "language_unidentified",
  "word_timing_estimated",
  "language_cues_skipped_mismatch",
  "silence_evidence_is_context_only",
]);
const reasonSet = new Set<string>(protectedSpeechReasons);
const evidenceSet = new Set<string>(spokenCandidateEvidenceCodes);
const kindSet = new Set<string>(spokenCandidateKinds);
const dispositionSet = new Set<string>(spokenCandidateDispositions);

function invalid(): never {
  throw new Error("Invalid spoken candidate contract.");
}

function record(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function exact(
  value: unknown,
  keys: readonly string[],
): asserts value is Record<string, unknown> {
  if (!record(value)) invalid();
  const actual = Object.keys(value).sort(),
    expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  )
    invalid();
}

function text(value: unknown, maximum: number): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    value.trim() !== value ||
    /[\x00-\x1f\x7f]/u.test(value)
  )
    invalid();
}

function integer(
  value: unknown,
  maximum = Number.MAX_SAFE_INTEGER,
): asserts value is number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > maximum
  )
    invalid();
}

function identifier(value: unknown): asserts value is string {
  if (typeof value !== "string" || !identifierPattern.test(value)) invalid();
}

function stringList(
  value: unknown,
  maximumItems: number,
  maximumText: number,
  phrase = false,
): asserts value is string[] {
  if (!Array.isArray(value) || value.length > maximumItems) invalid();
  const seen = new Set<string>();
  for (const item of value) {
    text(item, maximumText);
    if (phrase && !/[\p{L}\p{N}]/u.test(item)) invalid();
    const key = item.toLocaleLowerCase("en-US");
    if (seen.has(key)) invalid();
    seen.add(key);
  }
}

export function createDefaultSpokenCandidatePolicy(
  language: string,
): SpokenCandidatePolicy {
  const primary = language.toLocaleLowerCase("en-US").split(/[-_]/u)[0];
  const knownLanguage = primary !== "und" && Boolean(primary);
  return {
    schema_version: spokenCandidateSchemaVersion,
    cue_language: knownLanguage ? primary! : null,
    filler_cues: primary === "en" ? ["um", "uh", "erm", "hmm"] : [],
    editor_cue: "Hey Codex",
    legacy_editor_cues: ["Hey Borumi"],
    legacy_aliases_enabled: false,
    pause_review_threshold_us: 1_000_000,
    protected_word_ids: [],
    protected_ranges: [],
  };
}

export function assertSpokenCandidatePolicy(
  value: unknown,
): asserts value is SpokenCandidatePolicy {
  exact(value, [
    "schema_version",
    "cue_language",
    "filler_cues",
    "editor_cue",
    "legacy_editor_cues",
    "legacy_aliases_enabled",
    "pause_review_threshold_us",
    "protected_word_ids",
    "protected_ranges",
  ]);
  if (value.schema_version !== spokenCandidateSchemaVersion) invalid();
  if (value.cue_language !== null) {
    text(value.cue_language, 35);
    if (!/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u.test(value.cue_language))
      invalid();
  }
  stringList(value.filler_cues, 64, 128, true);
  text(value.editor_cue, 128);
  stringList(value.legacy_editor_cues, 16, 128, true);
  if (typeof value.legacy_aliases_enabled !== "boolean") invalid();
  if (
    typeof value.pause_review_threshold_us !== "number" ||
    !Number.isSafeInteger(value.pause_review_threshold_us) ||
    value.pause_review_threshold_us < 100_000 ||
    value.pause_review_threshold_us > 60_000_000
  )
    invalid();
  stringList(value.protected_word_ids, 100_000, 128);
  if (
    !Array.isArray(value.protected_ranges) ||
    value.protected_ranges.length > 4096
  )
    invalid();
  for (const range of value.protected_ranges) {
    exact(range, ["start_us", "end_us", "reason"]);
    integer(range.start_us);
    integer(range.end_us);
    if (
      (range.reason !== "manual" &&
        range.reason !== "sponsor" &&
        range.reason !== "licensed") ||
      range.start_us >= range.end_us
    )
      invalid();
  }
}

export function assertSpokenCandidateReport(
  value: unknown,
): asserts value is SpokenCandidateReport {
  exact(value, [
    "schema_version",
    "project_id",
    "source_id",
    "transcript_id",
    "source_sha256",
    "duration_us",
    "language",
    "authority",
    "candidates",
    "protected_words",
    "warnings",
  ]);
  if (
    value.schema_version !== spokenCandidateSchemaVersion ||
    value.authority !== "analysis_only"
  )
    invalid();
  identifier(value.project_id);
  identifier(value.source_id);
  identifier(value.transcript_id);
  if (
    typeof value.source_sha256 !== "string" ||
    !hashPattern.test(value.source_sha256)
  )
    invalid();
  integer(value.duration_us);
  text(value.language, 35);
  if (!Array.isArray(value.candidates) || value.candidates.length > 100_000)
    invalid();
  const candidateIds = new Set<string>();
  let previousStart = -1;
  for (const raw of value.candidates) {
    exact(raw, [
      "candidate_id",
      "kind",
      "disposition",
      "source_start_us",
      "source_end_us",
      "start_word_id",
      "end_word_id",
      "word_ids",
      "related_segment_id",
      "protected_word_ids",
      "protected_reasons",
      "evidence",
      "cut_authorized",
    ]);
    if (
      typeof raw.candidate_id !== "string" ||
      !/^candidate-[a-f0-9]{24}$/u.test(raw.candidate_id) ||
      candidateIds.has(raw.candidate_id) ||
      typeof raw.kind !== "string" ||
      !kindSet.has(raw.kind) ||
      typeof raw.disposition !== "string" ||
      !dispositionSet.has(raw.disposition) ||
      raw.cut_authorized !== false
    )
      invalid();
    candidateIds.add(raw.candidate_id);
    integer(raw.source_start_us, value.duration_us as number);
    integer(raw.source_end_us, value.duration_us as number);
    if (
      raw.source_start_us >= raw.source_end_us ||
      (raw.source_start_us as number) < previousStart
    )
      invalid();
    previousStart = raw.source_start_us as number;
    if (!Array.isArray(raw.word_ids) || raw.word_ids.length > 100_000)
      invalid();
    for (const id of raw.word_ids) identifier(id);
    if (
      raw.start_word_id !== null &&
      (typeof raw.start_word_id !== "string" ||
        raw.word_ids[0] !== raw.start_word_id)
    )
      invalid();
    if (
      raw.end_word_id !== null &&
      (typeof raw.end_word_id !== "string" ||
        raw.word_ids.at(-1) !== raw.end_word_id)
    )
      invalid();
    if (raw.kind === "long_pause") {
      if (
        raw.start_word_id !== null ||
        raw.end_word_id !== null ||
        raw.word_ids.length !== 0 ||
        raw.disposition !== "context_only"
      )
        invalid();
    } else if (
      typeof raw.start_word_id !== "string" ||
      typeof raw.end_word_id !== "string" ||
      raw.word_ids.length === 0
    )
      invalid();
    if (raw.related_segment_id !== null) identifier(raw.related_segment_id);
    stringList(raw.protected_word_ids, 100_000, 128);
    if (
      !Array.isArray(raw.protected_reasons) ||
      raw.protected_reasons.length > 16
    )
      invalid();
    for (const reason of raw.protected_reasons)
      if (typeof reason !== "string" || !reasonSet.has(reason)) invalid();
    if (!Array.isArray(raw.evidence) || raw.evidence.length === 0) invalid();
    for (const code of raw.evidence)
      if (typeof code !== "string" || !evidenceSet.has(code)) invalid();
    if (
      (raw.disposition === "protected") !==
      (raw.protected_reasons.length > 0 || raw.protected_word_ids.length > 0)
    )
      invalid();
  }
  if (
    !Array.isArray(value.protected_words) ||
    value.protected_words.length > 100_000
  )
    invalid();
  const protectedIds = new Set<string>();
  for (const raw of value.protected_words) {
    exact(raw, ["word_id", "reasons"]);
    identifier(raw.word_id);
    if (protectedIds.has(raw.word_id)) invalid();
    protectedIds.add(raw.word_id);
    if (!Array.isArray(raw.reasons) || raw.reasons.length === 0) invalid();
    for (const reason of raw.reasons)
      if (typeof reason !== "string" || !reasonSet.has(reason)) invalid();
  }
  if (!Array.isArray(value.warnings) || value.warnings.length > 16) invalid();
  for (const warning of value.warnings)
    if (typeof warning !== "string" || !warningCodes.has(warning)) invalid();
}

interface PositionedWord extends TranscriptWord {
  segment_id: string;
}

function exactAdjacentSegmentRepeat(
  previous: readonly PositionedWord[],
  current: readonly PositionedWord[],
): boolean {
  if (previous.length < 2 || previous.length !== current.length) return false;
  const previousEnd = previous.at(-1)!.end_us;
  if (current[0]!.start_us < previousEnd) return false;
  return previous.every((word, index) => {
    const left = normalizedToken(word.text);
    const right = normalizedToken(current[index]!.text);
    return left.length > 0 && left === right;
  });
}

const flagReasons = Object.freeze({
  uncertain: "uncertain",
  number: "number",
  name: "name",
  negation: "negation",
  protected: "protected",
  overlap: "overlap",
} satisfies Record<string, ProtectedSpeechReason>);

const languagePrimary = (value: string): string =>
  value.toLocaleLowerCase("en-US").split(/[-_]/u)[0] ?? "";

function normalizedToken(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
}

function normalizedPhrase(value: string): string[] {
  return value.split(/\s+/u).map(normalizedToken).filter(Boolean);
}

interface PhraseTrieNode<T> {
  children: Map<string, PhraseTrieNode<T>>;
  values: T[];
}

interface PhraseMatch<T> {
  start: number;
  length: number;
  value: T;
}

function findPhraseMatches<T>(
  words: readonly PositionedWord[],
  phrases: readonly { tokens: readonly string[]; value: T }[],
): PhraseMatch<T>[] {
  const root: PhraseTrieNode<T> = { children: new Map(), values: [] };
  let maximumLength = 0;
  for (const phrase of phrases) {
    if (phrase.tokens.length === 0) continue;
    maximumLength = Math.max(maximumLength, phrase.tokens.length);
    let node = root;
    for (const token of phrase.tokens) {
      let child = node.children.get(token);
      if (!child) {
        child = { children: new Map(), values: [] };
        node.children.set(token, child);
      }
      node = child;
    }
    node.values.push(phrase.value);
  }

  const matches: PhraseMatch<T>[] = [];
  for (let start = 0; start < words.length; start++) {
    const segmentId = words[start]!.segment_id;
    let node = root;
    for (
      let offset = 0;
      offset < maximumLength && start + offset < words.length;
      offset++
    ) {
      const word = words[start + offset]!;
      if (word.segment_id !== segmentId) break;
      const token = normalizedToken(word.text);
      const child = token ? node.children.get(token) : undefined;
      if (!child) break;
      node = child;
      for (const value of node.values)
        matches.push({ start, length: offset + 1, value });
    }
  }
  return matches;
}

function quoteMap(segments: LocalTranscript["segments"]): Set<string> {
  const quoted = new Set<string>();
  for (const segment of segments) {
    let quoteOpen = false;
    for (const word of segment.words) {
      const value = word.text;
      const asciiQuoteCount = [...value].filter((char) => char === '"').length;
      const opens = /[“„«‘]/u.test(value);
      const closes = /[”»’]/u.test(value);
      const inside =
        quoteOpen ||
        opens ||
        value.trimStart().startsWith('"') ||
        asciiQuoteCount > 1;
      if (inside) quoted.add(word.word_id);
      if (opens && !closes) quoteOpen = true;
      if (closes) quoteOpen = false;
      if (asciiQuoteCount % 2 === 1) quoteOpen = !quoteOpen;
      if (asciiQuoteCount > 1 && asciiQuoteCount % 2 === 0) quoteOpen = false;
    }
  }
  return quoted;
}

function protectedWords(
  transcript: LocalTranscript,
  policy: SpokenCandidatePolicy,
): Map<string, Set<ProtectedSpeechReason>> {
  const result = new Map<string, Set<ProtectedSpeechReason>>();
  const add = (wordId: string, reason: ProtectedSpeechReason) => {
    const reasons = result.get(wordId) ?? new Set<ProtectedSpeechReason>();
    reasons.add(reason);
    result.set(wordId, reasons);
  };
  const configuredIds = new Set(policy.protected_word_ids);
  const rangesByReason = new Map<
    SpokenProtectedRange["reason"],
    Array<{ start_us: number; end_us: number }>
  >();
  for (const range of policy.protected_ranges) {
    const ranges = rangesByReason.get(range.reason) ?? [];
    ranges.push({ start_us: range.start_us, end_us: range.end_us });
    rangesByReason.set(range.reason, ranges);
  }
  for (const [reason, ranges] of rangesByReason) {
    ranges.sort((left, right) => left.start_us - right.start_us);
    const merged: Array<{ start_us: number; end_us: number }> = [];
    for (const range of ranges) {
      const prior = merged.at(-1);
      if (prior && range.start_us <= prior.end_us)
        prior.end_us = Math.max(prior.end_us, range.end_us);
      else merged.push({ ...range });
    }
    rangesByReason.set(reason, merged);
  }
  const overlapsProtectedRange = (
    ranges: readonly { start_us: number; end_us: number }[],
    start_us: number,
    end_us: number,
  ): boolean => {
    let low = 0;
    let high = ranges.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (ranges[middle]!.end_us <= start_us) low = middle + 1;
      else high = middle;
    }
    return Boolean(
      ranges[low] &&
      ranges[low]!.start_us < end_us &&
      ranges[low]!.end_us > start_us,
    );
  };
  for (const segment of transcript.segments) {
    for (const word of segment.words) {
      if (configuredIds.has(word.word_id)) add(word.word_id, "protected");
      for (const flag of word.flags ?? []) add(word.word_id, flagReasons[flag]);
      for (const [reason, ranges] of rangesByReason)
        if (overlapsProtectedRange(ranges, word.start_us, word.end_us))
          add(word.word_id, reason);
    }
  }
  return result;
}

function candidateIdentifier(ordinal: number): string {
  return `candidate-${ordinal.toString(16).padStart(24, "0")}`;
}

/**
 * Deterministically finds review cues from a local word transcript. Silence is
 * returned only as contextual evidence. Every candidate is explicitly unable
 * to authorize a media cut; editing requires a separate user/transaction path.
 */
export function analyzeSpokenCandidates(
  transcript: LocalTranscript,
  analysis: TranscriptAnalysis,
  policy: SpokenCandidatePolicy,
): SpokenCandidateReport {
  assertLocalTranscript(transcript);
  assertTranscriptAnalysis(analysis);
  assertSpokenCandidatePolicy(policy);
  if (
    analysis.project_id !== transcript.project_id ||
    analysis.source_id !== transcript.source_id ||
    analysis.duration_us !== transcript.duration_us ||
    !Number.isSafeInteger(policy.pause_review_threshold_us) ||
    policy.protected_ranges.some(
      (range) => range.end_us > transcript.duration_us,
    )
  )
    invalid();

  const words: PositionedWord[] = [];
  const wordsBySegment: PositionedWord[][] = transcript.segments.map(() => []);
  for (const [segment_index, segment] of transcript.segments.entries()) {
    let previousStart = -1;
    for (const word of segment.words) {
      if (word.start_us < previousStart) invalid();
      previousStart = word.start_us;
      const positioned = {
        ...word,
        segment_id: segment.segment_id,
      };
      words.push(positioned);
      wordsBySegment[segment_index]!.push(positioned);
    }
  }

  const quotedWords = quoteMap(transcript.segments);
  const protectedByWord = protectedWords(transcript, policy);
  const transcriptLanguage = languagePrimary(transcript.language);
  const cueLanguage = policy.cue_language
    ? languagePrimary(policy.cue_language)
    : null;
  const languageMatches = Boolean(
    cueLanguage &&
    transcriptLanguage !== "und" &&
    cueLanguage === transcriptLanguage,
  );
  const warnings: SpokenCandidateReport["warnings"] = [];
  if (transcriptLanguage === "und") warnings.push("language_unidentified");
  else if (cueLanguage && !languageMatches)
    warnings.push("language_cues_skipped_mismatch");
  if (
    transcript.warnings?.some((warning) =>
      warning.startsWith("Word timings are local model estimates"),
    )
  )
    warnings.push("word_timing_estimated");

  const candidates: SpokenCandidate[] = [];
  const seen = new Set<string>();
  const addCandidate = (
    kind: SpokenCandidateKind,
    matchedWords: readonly PositionedWord[],
    evidence: readonly SpokenCandidateEvidenceCode[],
    contextOnly = false,
    relatedSegmentId?: string,
  ) => {
    const first = matchedWords[0];
    const last = matchedWords.at(-1);
    if (
      !first ||
      !last ||
      first.end_us <= first.start_us ||
      last.end_us <= first.start_us
    )
      return;
    const wordIds = matchedWords.map((word) => word.word_id);
    const quoted = matchedWords.some((word) => quotedWords.has(word.word_id));
    const protectedIds = wordIds.filter((id) => protectedByWord.has(id));
    const reasons = protectedSpeechReasons.filter((reason) =>
      protectedIds.some((id) => protectedByWord.get(id)?.has(reason)),
    );
    const uniqueEvidence = [
      ...new Set([
        ...evidence,
        ...(quoted ? ["quoted_speech_context" as const] : []),
      ]),
    ];
    const key = [
      transcript.transcript_id,
      transcript.source_id,
      kind,
      first.start_us,
      last.end_us,
      wordIds.join(","),
      uniqueEvidence.join(","),
    ].join("\0");
    if (seen.has(key)) return;
    const candidate: SpokenCandidate = {
      candidate_id: candidateIdentifier(candidates.length + 1),
      kind,
      disposition: protectedIds.length
        ? "protected"
        : contextOnly || quoted
          ? "context_only"
          : "review_required",
      source_start_us: first.start_us,
      source_end_us: last.end_us,
      start_word_id: first.word_id,
      end_word_id: last.word_id,
      word_ids: wordIds,
      related_segment_id: relatedSegmentId ?? first.segment_id,
      protected_word_ids: protectedIds,
      protected_reasons: reasons,
      evidence: uniqueEvidence,
      cut_authorized: false,
    };
    candidates.push(candidate);
    seen.add(key);
  };

  if (languageMatches) {
    const fillerPhrases = policy.filler_cues.map((cue) => ({
      tokens: normalizedPhrase(cue),
      value: "configured_filler_cue" as const,
    }));
    for (const match of findPhraseMatches(words, fillerPhrases)) {
      const matched = words.slice(match.start, match.start + match.length);
      const quoted = matched.some((word) => quotedWords.has(word.word_id));
      addCandidate(
        "filler",
        matched,
        [match.value, ...(quoted ? ["quoted_filler" as const] : [])],
        quoted,
      );
    }

    const configuredCue = normalizedPhrase(policy.editor_cue);
    const legacyCues = policy.legacy_aliases_enabled
      ? policy.legacy_editor_cues.map((cue) => normalizedPhrase(cue))
      : [];
    const cues = [
      ...(configuredCue.length
        ? [
            {
              tokens: configuredCue,
              evidence: "configured_editor_cue" as const,
            },
          ]
        : []),
      ...legacyCues
        .filter((phrase) => phrase.length > 0)
        .map((tokens) => ({
          tokens,
          evidence: "opted_in_legacy_cue" as const,
        })),
    ];
    for (const match of findPhraseMatches(
      words,
      cues.map(({ tokens, evidence }) => ({ tokens, value: evidence })),
    )) {
      const matched = words.slice(match.start, match.start + match.length);
      const quoted = matched.some((word) => quotedWords.has(word.word_id));
      addCandidate(
        "editor_cue",
        matched,
        [match.value, ...(quoted ? ["quoted_editor_cue" as const] : [])],
        quoted,
      );
    }
  }

  if (transcriptLanguage === "en" && cueLanguage === "en") {
    const corrections = [
      ["i", "mean"],
      ["let", "me", "rephrase"],
      ["actually"],
      ["rather"],
      ["sorry"],
    ];
    const correctionPhrases = corrections.map((phrase) => ({
      tokens: normalizedPhrase(phrase.join(" ")),
      value: "self_correction_marker" as const,
    }));
    for (const match of findPhraseMatches(words, correctionPhrases))
      addCandidate(
        "self_correction",
        words.slice(match.start, match.start + match.length),
        [match.value],
      );
  }

  for (const segmentWords of wordsBySegment) {
    for (let index = 0; index < segmentWords.length; index++) {
      const word = segmentWords[index]!;
      const next = segmentWords[index + 1];
      const markedWord = /(?:--+|[–—])\s*$/u.test(word.text);
      const dashToken = /^(?:--+|[–—])$/u.test(word.text);
      if (next && (markedWord || (dashToken && index > 0))) {
        const start = markedWord ? index : index - 1;
        const matched = segmentWords.slice(start, index + 1);
        addCandidate("false_start", matched, ["disfluent_restart"]);
      }

      const normalized = normalizedToken(word.text);
      const following = segmentWords[index + 1];
      if (
        normalized &&
        following &&
        normalized === normalizedToken(following.text) &&
        following.start_us - word.end_us <= 300_000
      ) {
        addCandidate("repeated_take", [following], ["exact_repeated_segment"]);
      }

      const maxPhrase = Math.min(
        12,
        Math.floor((segmentWords.length - index) / 2),
      );
      let repeatedLength = 0;
      for (let length = maxPhrase; length >= 2; length--) {
        const first = segmentWords.slice(index, index + length);
        const second = segmentWords.slice(index + length, index + length * 2);
        if (
          first.every(
            (item, offset) =>
              Boolean(normalizedToken(item.text)) &&
              normalizedToken(item.text) ===
                normalizedToken(second[offset]!.text),
          )
        ) {
          repeatedLength = length;
          break;
        }
      }
      if (repeatedLength) {
        addCandidate(
          "repeated_take",
          segmentWords.slice(
            index + repeatedLength,
            index + repeatedLength * 2,
          ),
          ["exact_repeated_segment"],
        );
        index += repeatedLength * 2 - 1;
      }
    }
  }

  for (let index = 1; index < wordsBySegment.length; index++) {
    const previous = wordsBySegment[index - 1]!;
    const current = wordsBySegment[index]!;
    if (exactAdjacentSegmentRepeat(previous, current))
      addCandidate(
        "repeated_take",
        current,
        ["exact_repeated_segment"],
        false,
        previous[0]!.segment_id,
      );
  }

  for (const silence of analysis.silences) {
    if (silence.end_us - silence.start_us < policy.pause_review_threshold_us)
      continue;
    const candidate: SpokenCandidate = {
      candidate_id: candidateIdentifier(candidates.length + 1),
      kind: "long_pause",
      disposition: "context_only",
      source_start_us: silence.start_us,
      source_end_us: silence.end_us,
      start_word_id: null,
      end_word_id: null,
      word_ids: [],
      related_segment_id: null,
      protected_word_ids: [],
      protected_reasons: [],
      evidence: ["long_silence_context"],
      cut_authorized: false,
    };
    candidates.push(candidate);
  }

  candidates.sort(
    (left, right) =>
      left.source_start_us - right.source_start_us ||
      left.source_end_us - right.source_end_us ||
      (left.kind < right.kind ? -1 : left.kind > right.kind ? 1 : 0),
  );
  if (candidates.some((candidate) => candidate.kind === "long_pause"))
    warnings.push("silence_evidence_is_context_only");

  const report: SpokenCandidateReport = {
    schema_version: spokenCandidateSchemaVersion,
    project_id: transcript.project_id,
    source_id: transcript.source_id,
    transcript_id: transcript.transcript_id,
    source_sha256: analysis.source_sha256,
    duration_us: transcript.duration_us,
    language: transcript.language,
    authority: "analysis_only",
    candidates,
    protected_words: words.flatMap((word) => {
      const reasons = protectedSpeechReasons.filter((reason) =>
        protectedByWord.get(word.word_id)?.has(reason),
      );
      return reasons.length ? [{ word_id: word.word_id, reasons }] : [];
    }),
    warnings: [...new Set(warnings)],
  };
  assertSpokenCandidateReport(report);
  return report;
}
