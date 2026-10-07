import assert from "node:assert/strict";
import test from "node:test";
import {
  balanceLines,
  buildCaptionCues,
  captionWordsForDraft,
  cueAt,
  joinCaptionWords,
  toSrt,
  toVtt,
  type CaptionSourceWord,
} from "../../packages/domain/src/captions.ts";

function words(
  sourceId: string,
  text: string,
  startUs: number,
  stepUs = 300_000,
): CaptionSourceWord[] {
  return text.split(" ").map((token, index) => ({
    sourceId,
    text: token,
    startUs: startUs + index * stepUs,
    endUs: startUs + index * stepUs + stepUs - 50_000,
  }));
}

test("punctuation attaches to its neighbour", () => {
  assert.equal(
    joinCaptionWords(["Hello", ",", "“", "world", "”", "(", "ok", ")", "."]),
    "Hello, “world” (ok).",
  );
});

test("captions follow cuts and drop partly cut words", () => {
  const source = words("a", "one two three four five six", 0);
  // Keep one..two, cut three and half of four, keep five..six.
  const clips = [
    {
      sourceId: "a",
      timelineStartUs: 0,
      sourceStartUs: 0,
      sourceEndUs: 600_000,
    },
    {
      sourceId: "a",
      timelineStartUs: 600_000,
      sourceStartUs: 1_000_000,
      sourceEndUs: 1_800_000,
    },
  ];
  const mapped = captionWordsForDraft(source, clips);
  assert.deepEqual(
    mapped.map((word) => word.text),
    ["one", "two", "five", "six"],
  );
  assert.equal(mapped[2]!.startUs, 600_000 + 200_000);
  const cues = buildCaptionCues(mapped);
  assert.equal(cues.length, 1);
  assert.deepEqual(cues[0]!.lines, ["one two five six"]);
  assert.equal(cueAt(cues, 0)?.lines[0], "one two five six");
  assert.equal(cueAt(cues, 10_000_000), undefined);
});

test("pauses, sentences, length and duration start new captions", () => {
  const first = words("a", "This is the first sentence.", 0);
  const second = words("a", "After a pause we continue", 3_000_000);
  const cues = buildCaptionCues(
    captionWordsForDraft(
      [...first, ...second],
      [
        {
          sourceId: "a",
          timelineStartUs: 0,
          sourceStartUs: 0,
          sourceEndUs: 10_000_000,
        },
      ],
    ),
  );
  assert.deepEqual(
    cues.map((cue) => cue.lines.join(" / ")),
    ["This is the first sentence.", "After a pause we continue"],
  );
  // The first caption holds briefly but never overlaps the next.
  assert.ok(cues[0]!.endUs <= cues[1]!.startUs);
  const long = words(
    "a",
    "a fairly long run of spoken words that keeps going well beyond what two caption lines of forty two characters can hold at once",
    0,
    200_000,
  );
  const split = buildCaptionCues(
    captionWordsForDraft(long, [
      {
        sourceId: "a",
        timelineStartUs: 0,
        sourceStartUs: 0,
        sourceEndUs: 60_000_000,
      },
    ]),
  );
  assert.ok(split.length >= 2);
  for (const cue of split) {
    assert.ok(cue.lines.length <= 2);
    assert.ok(
      cue.lines.every((line) => line.length <= 42),
      cue.lines.join("|"),
    );
    assert.ok(cue.endUs - cue.startUs <= 6_500_000);
  }
  for (let index = 1; index < split.length; index++)
    assert.ok(split[index - 1]!.endUs <= split[index]!.startUs);
});

test("two lines are balanced and prefer a break after a comma", () => {
  assert.deepEqual(
    balanceLines(
      "When you open the settings, choose the screen you want".split(" "),
      42,
      2,
    ),
    ["When you open the settings,", "choose the screen you want"],
  );
  assert.equal(balanceLines(["x".repeat(50)], 42, 2), null);
});

test("SRT and WebVTT sidecars use exact cue times", () => {
  const cues = [
    {
      startUs: 1_234_567,
      endUs: 3_600_000_000 + 2_000_000,
      lines: ["Tom & <Jerry>", "second line"],
      lineWordCounts: [3, 2],
      words: [],
    },
  ];
  assert.equal(
    toSrt(cues),
    "1\r\n00:00:01,235 --> 01:00:02,000\r\nTom & <Jerry>\r\nsecond line\r\n",
  );
  assert.equal(
    toVtt(cues),
    "WEBVTT\n\n00:00:01.235 --> 01:00:02.000\nTom &amp; &lt;Jerry&gt;\nsecond line\n",
  );
});
