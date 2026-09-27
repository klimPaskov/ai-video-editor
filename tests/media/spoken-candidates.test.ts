import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeSpokenCandidates,
  assertSpokenCandidatePolicy,
  assertSpokenCandidateReport,
  createDefaultSpokenCandidatePolicy,
} from "../../packages/domain/src/spoken-candidates.ts";
import type {
  LocalTranscript,
  TranscriptAnalysis,
  TranscriptWord,
} from "../../packages/domain/src/transcription.ts";
import type { SpokenCandidatePolicy } from "../../packages/domain/src/spoken-candidates.ts";

interface Token {
  text: string;
  flags?: TranscriptWord["flags"];
}

function fixture(): {
  transcript: LocalTranscript;
  analysis: TranscriptAnalysis;
  policy: SpokenCandidatePolicy;
} {
  const tokens: Token[] = [
    { text: "Um,", flags: ["uncertain"] },
    { text: "Uh," },
    { text: "the" },
    { text: "demo" },
    { text: "the" },
    { text: "demo" },
    { text: "I" },
    { text: "thought" },
    { text: "this" },
    { text: "would" },
    { text: "work—" },
    { text: "Actually," },
    { text: "it" },
    { text: "works." },
    { text: "Hey" },
    { text: "Codex," },
    { text: "please" },
    { text: "make" },
    { text: "a" },
    { text: "chart." },
    { text: "They" },
    { text: "said" },
    { text: "“Hey" },
    { text: "Codex”" },
    { text: "and" },
    { text: '"Hey' },
    { text: 'Codex"' },
    { text: "yesterday." },
    { text: "Hey" },
    { text: "Borumi," },
    { text: "skip" },
    { text: "the" },
    { text: "intro." },
    { text: "I" },
    { text: "mean," },
    { text: "keep" },
    { text: "the" },
    { text: "opening." },
    { text: "Acme", flags: ["name"] },
    { text: "has" },
    { text: "3", flags: ["number"] },
    { text: "files," },
    { text: "not", flags: ["negation"] },
    { text: "two." },
  ];
  const words = tokens.map((token, index) => {
    const start_us = 100_000 + index * 250_000;
    return {
      word_id: `word-${String(index + 1).padStart(6, "0")}`,
      text: token.text,
      start_us,
      end_us: start_us + 180_000,
      confidence: null,
      flags: token.flags ?? [],
    } satisfies TranscriptWord;
  });
  const transcript: LocalTranscript = {
    schema_version: "1.0",
    transcript_id: "transcript-synthetic-01",
    project_id: "project-synthetic-01",
    source_id: "source-mic-synthetic-01",
    duration_us: 12_000_000,
    language: "en",
    model: { provider: "local", name: "fixture", version: "1" },
    segments: [
      {
        segment_id: "segment-synthetic-01",
        start_us: words[0]!.start_us,
        end_us: words.at(-1)!.end_us,
        text: words.map((word) => word.text).join(" "),
        words,
      },
    ],
    warnings: [
      "Word timings are local model estimates; verify before editing.",
    ],
  };
  const acme = words.find((word) => word.text === "Acme")!;
  const analysis: TranscriptAnalysis = {
    schema_version: "1.0",
    project_id: transcript.project_id,
    source_id: transcript.source_id,
    source_sha256: "a".repeat(64),
    duration_us: transcript.duration_us,
    silence_policy: {
      version: "1",
      noise_db: -40,
      minimum_duration_us: 250_000,
    },
    silences: [{ start_us: 10_500_000, end_us: 11_700_000 }],
  };
  const policy = createDefaultSpokenCandidatePolicy(transcript.language);
  policy.protected_word_ids = [words[0]!.word_id];
  policy.protected_ranges = [
    { start_us: acme.start_us, end_us: acme.end_us, reason: "sponsor" },
  ];
  return { transcript, analysis, policy };
}

test("deterministic analysis labels candidates, preserves protected speech and never authorizes cuts", () => {
  const { transcript, analysis, policy } = fixture();
  const before = structuredClone({ transcript, analysis, policy });
  const report = analyzeSpokenCandidates(transcript, analysis, policy);
  const repeated = analyzeSpokenCandidates(transcript, analysis, policy);
  assert.deepEqual(report, repeated);
  assert.deepEqual({ transcript, analysis, policy }, before);
  assertSpokenCandidateReport(report);

  const find = (kind: string, text: string) =>
    report.candidates.find(
      (candidate) =>
        candidate.kind === kind &&
        candidate.word_ids.some((wordId) =>
          transcript.segments[0]!.words.find((word) => word.word_id === wordId)
            ?.text.toLocaleLowerCase("en-US")
            .startsWith(text.toLocaleLowerCase("en-US")),
        ),
    );
  assert.equal(find("filler", "Um")?.disposition, "protected");
  assert.equal(find("filler", "Uh")?.disposition, "review_required");
  assert.equal(
    find("false_start", "work")?.evidence.includes("disfluent_restart"),
    true,
  );
  assert.equal(find("repeated_take", "the")?.word_ids.length, 2);
  assert.equal(
    find("self_correction", "I")?.evidence.includes("self_correction_marker"),
    true,
  );
  assert.equal(find("editor_cue", "Hey")?.disposition, "review_required");
  assert.equal(find("editor_cue", "“Hey")?.disposition, "context_only");
  assert.equal(
    find("editor_cue", "“Hey")?.evidence.includes("quoted_editor_cue"),
    true,
  );
  assert.equal(find("editor_cue", "Hey")?.word_ids.length, 2);
  assert.equal(
    report.candidates.find(
      (candidate) =>
        candidate.kind === "editor_cue" &&
        candidate.evidence.includes("quoted_editor_cue"),
    )?.disposition,
    "context_only",
  );
  assert.equal(
    report.candidates.filter(
      (candidate) =>
        candidate.kind === "editor_cue" &&
        candidate.evidence.includes("quoted_editor_cue"),
    ).length,
    2,
  );
  assert.equal(
    report.candidates.some((candidate) => candidate.kind === "long_pause"),
    true,
  );
  assert.equal(
    report.candidates.find((candidate) => candidate.kind === "long_pause")
      ?.disposition,
    "context_only",
  );
  assert.ok(report.warnings.includes("word_timing_estimated"));
  assert.ok(report.warnings.includes("silence_evidence_is_context_only"));
  assert.ok(
    report.protected_words.some((word) => word.reasons.includes("name")),
  );
  assert.ok(
    report.protected_words.some((word) => word.reasons.includes("number")),
  );
  assert.ok(
    report.protected_words.some((word) => word.reasons.includes("negation")),
  );
  assert.ok(
    report.protected_words.some((word) => word.reasons.includes("sponsor")),
  );
  assert.ok(
    report.candidates.every((candidate) => candidate.cut_authorized === false),
  );
});

test("unknown and mismatched languages disable configured lexical cues", () => {
  const unknown = fixture();
  unknown.transcript.language = "und";
  const unknownPolicy = createDefaultSpokenCandidatePolicy("und");
  const unknownReport = analyzeSpokenCandidates(
    unknown.transcript,
    unknown.analysis,
    unknownPolicy,
  );
  assert.ok(unknownReport.warnings.includes("language_unidentified"));
  assert.equal(
    unknownReport.candidates.some(
      (candidate) =>
        candidate.kind === "filler" || candidate.kind === "editor_cue",
    ),
    false,
  );

  const mismatched = fixture();
  mismatched.transcript.language = "es";
  const mismatchReport = analyzeSpokenCandidates(
    mismatched.transcript,
    mismatched.analysis,
    mismatched.policy,
  );
  assert.ok(mismatchReport.warnings.includes("language_cues_skipped_mismatch"));
  assert.equal(
    mismatchReport.candidates.some(
      (candidate) =>
        candidate.kind === "filler" || candidate.kind === "editor_cue",
    ),
    false,
  );
});

test("legacy editor cues stay opt-in and quoted variants stay context-only", () => {
  const { transcript, analysis, policy } = fixture();
  const normal = analyzeSpokenCandidates(transcript, analysis, policy);
  assert.equal(
    normal.candidates.some((candidate) =>
      candidate.evidence.includes("opted_in_legacy_cue"),
    ),
    false,
  );
  policy.legacy_aliases_enabled = true;
  const optedIn = analyzeSpokenCandidates(transcript, analysis, policy);
  const legacy = optedIn.candidates.find((candidate) =>
    candidate.evidence.includes("opted_in_legacy_cue"),
  );
  assert.equal(legacy?.kind, "editor_cue");
  assert.equal(legacy?.disposition, "review_required");
  assert.equal(legacy?.cut_authorized, false);
});

test("adjacent identical transcript segments are review-only repeated-take candidates", () => {
  const words = [
    {
      word_id: "word-first-01",
      text: "The",
      start_us: 100_000,
      end_us: 180_000,
    },
    {
      word_id: "word-first-02",
      text: "release",
      start_us: 200_000,
      end_us: 360_000,
    },
    {
      word_id: "word-first-03",
      text: "is",
      start_us: 380_000,
      end_us: 430_000,
    },
    {
      word_id: "word-first-04",
      text: "ready.",
      start_us: 450_000,
      end_us: 600_000,
    },
    {
      word_id: "word-second-01",
      text: "the",
      start_us: 900_000,
      end_us: 980_000,
    },
    {
      word_id: "word-second-02",
      text: "release",
      start_us: 1_000_000,
      end_us: 1_160_000,
    },
    {
      word_id: "word-second-03",
      text: "is",
      start_us: 1_180_000,
      end_us: 1_230_000,
    },
    {
      word_id: "word-second-04",
      text: "ready!",
      start_us: 1_250_000,
      end_us: 1_400_000,
    },
  ] satisfies TranscriptWord[];
  const transcript: LocalTranscript = {
    schema_version: "1.0",
    transcript_id: "transcript-repeated-segments-01",
    project_id: "project-repeated-segments-01",
    source_id: "source-repeated-segments-01",
    duration_us: 2_000_000,
    language: "en",
    model: { provider: "local", name: "fixture", version: "1" },
    segments: [
      {
        segment_id: "segment-first-01",
        start_us: 100_000,
        end_us: 600_000,
        text: "The release is ready.",
        words: words.slice(0, 4),
      },
      {
        segment_id: "segment-second-01",
        start_us: 900_000,
        end_us: 1_400_000,
        text: "the release is ready!",
        words: words.slice(4),
      },
    ],
    warnings: [],
  };
  const analysis: TranscriptAnalysis = {
    schema_version: "1.0",
    project_id: transcript.project_id,
    source_id: transcript.source_id,
    source_sha256: "b".repeat(64),
    duration_us: transcript.duration_us,
    silence_policy: {
      version: "1",
      noise_db: -40,
      minimum_duration_us: 250_000,
    },
    silences: [],
  };
  const report = analyzeSpokenCandidates(
    transcript,
    analysis,
    createDefaultSpokenCandidatePolicy("en"),
  );
  const repeat = report.candidates.find(
    (candidate) => candidate.kind === "repeated_take",
  );
  assert.deepEqual(
    repeat?.word_ids,
    words.slice(4).map((word) => word.word_id),
  );
  assert.equal(repeat?.related_segment_id, "segment-second-01");
  assert.equal(repeat?.disposition, "review_required");
  assert.equal(repeat?.cut_authorized, false);
});

test("analysis rejects transcript/source mismatches and the report rejects cut authority", () => {
  const { transcript, analysis, policy } = fixture();
  assert.throws(() =>
    analyzeSpokenCandidates(
      transcript,
      { ...analysis, source_id: "other-source" },
      policy,
    ),
  );
  const report = analyzeSpokenCandidates(transcript, analysis, policy);
  const invalid = structuredClone(report);
  (invalid.candidates[0] as unknown as Record<string, unknown>).cut_authorized =
    true;
  assert.throws(() => assertSpokenCandidateReport(invalid));
  const extra = { ...policy, source_path: "C:/private/source.mp4" };
  assert.throws(() => assertSpokenCandidatePolicy(extra));
});
