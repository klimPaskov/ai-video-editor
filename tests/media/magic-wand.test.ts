import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  mapCutsToOutput,
  planMagicWandCuts,
  type MagicSourceInput,
} from "../../packages/domain/src/magic-wand.ts";
import {
  analyzeSpokenCandidates,
  createDefaultSpokenCandidatePolicy,
} from "../../packages/domain/src/spoken-candidates.ts";
import {
  assertMagicWandView,
  idleMagicWandView,
  magicWandIssues,
} from "../../packages/domain/src/magic-wand-view.ts";
import type {
  LocalTranscript,
  TranscriptAnalysis,
  TranscriptWord,
} from "../../packages/domain/src/transcription.ts";

type Spoken = [
  text: string,
  start: number,
  end: number,
  flags?: TranscriptWord["flags"],
];

let wordCounter = 0;
function segment(id: string, words: Spoken[]) {
  const items = words.map(([text, start, end, flags]) => ({
    word_id: `word-${String(++wordCounter).padStart(6, "0")}`,
    text,
    start_us: start,
    end_us: end,
    confidence: null,
    flags: flags ?? [],
  }));
  return {
    segment_id: id,
    start_us: items[0]!.start_us,
    end_us: items.at(-1)!.end_us,
    text: items.map((word) => word.text).join(" "),
    words: items,
  };
}

function source(
  segments: ReturnType<typeof segment>[],
  silences: { start_us: number; end_us: number }[],
  sourceId = "source-mic-01",
): MagicSourceInput {
  const transcript: LocalTranscript = {
    schema_version: "1.0",
    transcript_id: `transcript-${sourceId}`,
    project_id: "project-01",
    source_id: sourceId,
    duration_us: 8_000_000,
    language: "en",
    model: { provider: "local", name: "fixture", version: "1" },
    segments,
    warnings: [
      "Word timings are local model estimates; verify before editing.",
    ],
  };
  const analysis: TranscriptAnalysis = {
    schema_version: "1.0",
    project_id: "project-01",
    source_id: sourceId,
    source_sha256: "a".repeat(64),
    duration_us: transcript.duration_us,
    silence_policy: {
      version: "1",
      noise_db: -40,
      minimum_duration_us: 250_000,
    },
    silences,
  };
  return {
    sourceId,
    transcript,
    analysis,
    report: analyzeSpokenCandidates(
      transcript,
      analysis,
      createDefaultSpokenCandidatePolicy("en"),
    ),
  };
}

function fixture(): MagicSourceInput {
  wordCounter = 0;
  return source(
    [
      segment("segment-01", [
        ["Welcome", 500_000, 800_000],
        ["to", 850_000, 950_000],
        ["the", 1_000_000, 1_150_000],
        ["demo.", 1_200_000, 1_700_000],
      ]),
      segment("segment-02", [
        ["Welcome", 2_000_000, 2_300_000],
        ["to", 2_350_000, 2_450_000],
        ["the", 2_500_000, 2_650_000],
        ["demo.", 2_700_000, 3_200_000],
      ]),
      segment("segment-03", [
        ["Today", 6_000_000, 6_300_000],
        ["um", 6_400_000, 6_600_000],
        ["we", 6_700_000, 6_900_000],
        ["start", 7_000_000, 7_300_000],
        ["and", 7_400_000, 7_600_000],
        ["uh", 7_610_000, 7_700_000],
        ["Acme", 7_710_000, 7_900_000, ["name"]],
      ]),
    ],
    [
      // Short silence: below every preset's pause threshold.
      { start_us: 1_720_000, end_us: 1_980_000 },
      { start_us: 3_300_000, end_us: 5_500_000 },
    ],
  );
}

test("gentle keeps fillers and shortens only very long pauses; the final take stays", () => {
  const plan = planMagicWandCuts([fixture()], "gentle");
  assert.deepEqual(
    plan.cuts.map(({ startUs, endUs, kinds }) => [startUs, endUs, kinds]),
    [
      // Earlier copy of the repeated sentence, joined at gap midpoints.
      [250_000, 1_850_000, ["repeated_take"]],
      // 2.2 s pause keeps 0.8 s.
      [3_700_000, 5_100_000, ["pause"]],
    ],
  );
});

test("balanced lifts out a cleanly separated filler but not a packed one or protected speech", () => {
  const plan = planMagicWandCuts([fixture()], "balanced");
  assert.deepEqual(
    plan.cuts.map(({ startUs, endUs, kinds }) => [startUs, endUs, kinds]),
    [
      [250_000, 1_850_000, ["repeated_take"]],
      [3_550_000, 5_250_000, ["pause"]],
      [6_350_000, 6_650_000, ["filler"]],
    ],
  );
  // "uh" touches its neighbours (10 ms gaps): left for review.
  assert.ok(plan.leftForReview >= 1);
  const words = fixture().transcript.segments.flatMap((item) => item.words);
  for (const cut of plan.cuts)
    for (const word of words) {
      const overlaps = word.start_us < cut.endUs && word.end_us > cut.startUs;
      if (overlaps)
        assert.ok(
          word.start_us >= cut.startUs && word.end_us <= cut.endUs,
          `cut ${cut.startUs}-${cut.endUs} splits "${word.text}"`,
        );
      if ((word.flags ?? []).includes("name"))
        assert.ok(!overlaps, "protected names are never cut");
    }
});

test("tight shortens shorter pauses but never a pause containing speech", () => {
  wordCounter = 0;
  const input = source(
    [
      segment("segment-01", [
        ["One", 100_000, 400_000],
        ["two", 1_300_000, 1_500_000],
        ["three", 3_000_000, 3_300_000],
      ]),
    ],
    [
      { start_us: 400_000, end_us: 1_300_000 },
      // Detected silence that overlaps a word: only the free side is used.
      { start_us: 1_450_000, end_us: 2_000_000 },
    ],
  );
  const plan = planMagicWandCuts([input], "tight");
  assert.deepEqual(
    plan.cuts.map(({ startUs, endUs }) => [startUs, endUs]),
    [[550_000, 1_150_000]],
  );
});

test("source cuts map onto the current draft, skip removed material and sort latest first", () => {
  const output = mapCutsToOutput(
    [
      { sourceId: "a", startUs: 1_000_000, endUs: 2_000_000, kinds: ["pause"] },
      {
        sourceId: "a",
        startUs: 5_000_000,
        endUs: 6_000_000,
        kinds: ["filler"],
      },
      { sourceId: "b", startUs: 0, endUs: 500_000, kinds: ["repeated_take"] },
    ],
    [
      // Source a 0..1.5 s, then a 4..8 s (1.5..4 s already cut), then b.
      {
        source_id: "a",
        source_start_us: 0,
        source_end_us: 1_500_000,
        timeline_start_us: 0,
        timeline_end_us: 1_500_000,
      },
      {
        source_id: "a",
        source_start_us: 4_000_000,
        source_end_us: 8_000_000,
        timeline_start_us: 1_500_000,
        timeline_end_us: 5_500_000,
      },
      {
        source_id: "b",
        source_start_us: 0,
        source_end_us: 3_000_000,
        timeline_start_us: 5_500_000,
        timeline_end_us: 8_500_000,
      },
    ],
  );
  assert.deepEqual(output, [
    { start_us: 5_500_000, end_us: 6_000_000, kinds: ["repeated_take"] },
    { start_us: 2_500_000, end_us: 3_500_000, kinds: ["filler"] },
    { start_us: 1_000_000, end_us: 1_500_000, kinds: ["pause"] },
  ]);
});

test("inputs from different sources are rejected", () => {
  const input = fixture();
  assert.throws(() =>
    planMagicWandCuts([{ ...input, sourceId: "another-source" }], "balanced"),
  );
});

test("Magic Edit views carry counts and fixed messages only", () => {
  assertMagicWandView(idleMagicWandView());
  const done = {
    status: "completed",
    projectId: "project-01",
    preset: "balanced",
    progress: null,
    summary: {
      removedUs: 3_000_000,
      cuts: 3,
      pauses: 1,
      fillers: 1,
      repeatedTakes: 1,
      leftForReview: 2,
    },
    message: null,
  };
  assertMagicWandView(done);
  for (const bad of [
    { ...done, message: "worker crashed: /home/user" },
    { ...done, summary: null },
    { ...done, progress: 0.5 },
    { ...done, ranges: [[0, 1]] },
    { ...done, status: "failed", summary: null, message: null },
    { ...idleMagicWandView(), message: magicWandIssues.failed },
  ])
    assert.throws(() => assertMagicWandView(bad), JSON.stringify(bad));
});

test("IPC schema Magic Edit messages equal the domain's fixed messages", async () => {
  const schema = JSON.parse(
    await readFile("docs/schemas/desktop_ipc.schema.json", "utf8"),
  ) as {
    $defs: { magicWandView: { properties: { message: { enum: unknown[] } } } };
  };
  assert.deepEqual(schema.$defs.magicWandView.properties.message.enum, [
    null,
    ...Object.values(magicWandIssues),
  ]);
});
