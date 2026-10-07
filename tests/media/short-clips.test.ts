import assert from "node:assert/strict";
import test from "node:test";
import type { CaptionWord } from "../../packages/domain/src/captions.ts";
import {
  draftWindowClips,
  findShortCandidates,
  reframeFilter,
  shortWords,
  splitSentences,
} from "../../packages/domain/src/short-clips.ts";

/** Words spoken at 2.5 words per second from `startUs`. */
function speak(text: string, startUs: number): CaptionWord[] {
  return text.split(" ").map((token, index) => ({
    text: token,
    startUs: startUs + index * 400_000,
    endUs: startUs + index * 400_000 + 350_000,
  }));
}

function paragraph(sentence: string, count: number, startUs: number) {
  const words: CaptionWord[] = [];
  let at = startUs;
  for (let index = 0; index < count; index++) {
    const spoken = speak(sentence, at);
    words.push(...spoken);
    at = spoken.at(-1)!.endUs + 300_000;
  }
  return { words, endUs: at };
}

test("sentences end at punctuation or long pauses", () => {
  const words = [
    ...speak("One two three.", 0),
    ...speak("four five", 2_000_000),
    ...speak("six seven", 5_000_000),
  ];
  assert.deepEqual(
    splitSentences(words).map((sentence) => [sentence.text, sentence.complete]),
    [
      ["One two three.", true],
      ["four five", false],
      ["six seven", false],
    ],
  );
});

test("finds self-contained moments and avoids dependent openings", () => {
  const intro = paragraph(
    "Here is how to record a clean demo of your app in minutes.",
    6,
    0,
  );
  const dependent = paragraph(
    "And that is why the second step matters so much for everyone here.",
    6,
    intro.endUs + 3_000_000,
  );
  const question = paragraph(
    "Why do most screen recordings feel slow to watch at all?",
    6,
    dependent.endUs + 3_000_000,
  );
  const words = [...intro.words, ...dependent.words, ...question.words];
  const found = findShortCandidates(words);
  assert.ok(found.length >= 2);
  for (const clip of found) {
    const duration = clip.endUs - clip.startUs;
    assert.ok(duration >= 15_000_000 && duration <= 60_000_000);
    assert.ok(!/^And\b/u.test(clip.title), clip.title);
    assert.ok(clip.score >= 0.55);
  }
  for (let index = 1; index < found.length; index++)
    assert.ok(found[index - 1]!.endUs <= found[index]!.startUs);
  const asking = found.find((clip) => clip.title.startsWith("Why"));
  assert.ok(asking?.reasons.includes("Opens with a question"));
  assert.ok(
    found.every((clip) => clip.reasons.includes("Ends on a complete sentence")),
  );
});

test("a draft too short for a clip gives no candidates", () => {
  assert.deepEqual(findShortCandidates(speak("Just a few words here.", 0)), []);
});

test("a window maps through cuts to source ranges and shifts words", () => {
  const clips = [
    {
      sourceId: "a",
      timelineStartUs: 0,
      timelineEndUs: 10_000_000,
      sourceStartUs: 0,
      sourceEndUs: 10_000_000,
    },
    {
      sourceId: "a",
      timelineStartUs: 10_000_000,
      timelineEndUs: 20_000_000,
      sourceStartUs: 15_000_000,
      sourceEndUs: 25_000_000,
    },
  ];
  assert.deepEqual(draftWindowClips(clips, 8_000_000, 12_000_000), [
    { sourceId: "a", sourceStartUs: 8_000_000, sourceEndUs: 10_000_000 },
    { sourceId: "a", sourceStartUs: 15_000_000, sourceEndUs: 17_000_000 },
  ]);
  assert.deepEqual(
    shortWords(speak("a b c", 1_000_000), 1_400_000, 3_000_000),
    [
      { text: "b", startUs: 0, endUs: 350_000 },
      { text: "c", startUs: 400_000, endUs: 750_000 },
    ],
  );
});

test("reframing filters target the short's size", () => {
  assert.match(
    reframeFilter("vertical", "fill", 0.25),
    /scale=1080:1920.*crop=1080:1920:\(iw-ow\)\*0\.2500/u,
  );
  assert.match(
    reframeFilter("square", "fit"),
    /overlay=\(W-w\)\/2:\(H-h\)\/2/u,
  );
});

test("clips start at real sentence starts, not after a pause split", () => {
  // Shaped like a real talk transcript: a sentence broken by a long pause.
  const words = [
    ...speak(
      "So in college, I was a government major, which meant a lot of papers.",
      0,
    ),
    ...speak(
      "Now, when a normal student writes a paper, they spread the work out.",
      5_000_000,
    ),
    ...speak("So, you know,", 10_000_000),
    ...speak(
      "you get started slowly, but you get enough done in the first week.",
      13_500_000,
    ),
    ...speak(
      "That would be the plan and I would have it all ready to go then.",
      19_000_000,
    ),
    ...speak(
      "But then came my ninety page senior thesis, a paper for a whole year.",
      24_000_000,
    ),
  ];
  const found = findShortCandidates(words);
  assert.ok(found.length >= 1);
  for (const clip of found)
    assert.ok(
      /^[A-Z]/u.test(clip.title) && !clip.title.startsWith("you"),
      clip.title,
    );
  // Never from the pause-split remainder at 13.5 s.
  assert.ok(found.every((clip) => clip.startUs !== 13_500_000));
});
