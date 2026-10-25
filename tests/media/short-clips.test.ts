import assert from "node:assert/strict";
import test from "node:test";
import type { CaptionWord } from "../../packages/domain/src/captions.ts";
import { assertGraphicContent } from "../../packages/domain/src/graphics.ts";
import {
  draftWindowClips,
  findShortCandidates,
  proposeShortCandidates,
  reframeFilter,
  shortSpeedFits,
  shortTitleBox,
  shortTitleInterval,
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

test("a speed fits only when every part of the clip can play that much faster", () => {
  assert.equal(shortSpeedFits([undefined, 1], 2), true);
  assert.equal(shortSpeedFits([2, 4], 2), true);
  assert.equal(shortSpeedFits([undefined, 3], 2), false);
  assert.equal(shortSpeedFits([8], 2), false);
  assert.equal(shortSpeedFits([3, 8], 1), true);
});

test("a title stays inside the picture of each format and framing", () => {
  const wide = { width: 2560, height: 1440 };
  // Fit shows the whole frame; the title spans most of its width.
  const fit = shortTitleBox("vertical", "fit", 0.5, wide);
  assert.ok(Math.abs(fit.left + fit.width / 2 - 0.5) < 1e-9);
  assert.ok(fit.width > 0.8);
  // Fill crops a 9:16 slice out of 16:9: the title stays inside that slice.
  for (const position of [0, 0.5, 1]) {
    const box = shortTitleBox("vertical", "fill", position, wide);
    const slice = 9 / 16 / (16 / 9);
    const left = position * (1 - slice);
    assert.ok(box.left >= left - 1e-9, `left at ${position}`);
    assert.ok(
      box.left + box.width <= left + slice + 1e-9,
      `right at ${position}`,
    );
  }
  // A landscape fill of a landscape frame crops nothing.
  assert.deepEqual(
    shortTitleBox("landscape", "fill", 0.2, wide),
    shortTitleBox("landscape", "fit", 0.9, wide),
  );
});

test("a title is a safe overlay that follows the speed and the clip length", () => {
  const box = { left: 0.08, width: 0.84 };
  const title = shortTitleInterval(
    'Why <b>this</b> & "that"?',
    20_000_000,
    box,
  );
  assert.ok(title);
  assert.equal(title!.startUs, 0);
  assert.equal(title!.endUs, 3_000_000);
  assert.equal(title!.layer, 99);
  assert.match(
    title!.html,
    /Why &lt;b&gt;this&lt;\/b&gt; &amp; &quot;that&quot;\?/u,
  );
  assertGraphicContent(title!.html, title!.css);
  // At 2x the title still shows for its own time; a short clip ends it early.
  assert.equal(shortTitleInterval("Hi", 20_000_000, box, 2)!.endUs, 3_000_000);
  assert.equal(shortTitleInterval("Hi", 4_000_000, box, 2)!.endUs, 2_000_000);
  assert.equal(shortTitleInterval("   ", 20_000_000, box), null);
  assert.equal(shortTitleInterval("Hi", 500_000, box), null);
  assert.ok(
    (
      shortTitleInterval("x".repeat(500), 20_000_000, box)!.html.match(/x/gu) ??
      []
    ).length <= 80,
  );
});

test("proposed clips snap to spoken words and keep the same rules", () => {
  // A monologue of about 100 s, one word every 0.4 s.
  const words = paragraph(
    "Here is how to record a clean demo of your app in minutes.",
    22,
    0,
  ).words;
  const result = proposeShortCandidates(words, [
    // Snaps to word edges; 30 s.
    {
      start_us: 10_100_000,
      end_us: 40_300_000,
      title: "  The best  demo\u0000tip ",
      reasons: [
        "Opens clearly",
        "x".repeat(200),
        "",
        "Third",
        "Fourth",
        "Fifth",
      ],
    },
    // Overlaps the first.
    { start_us: 35_000_000, end_us: 60_000_000, title: "Overlap", reasons: [] },
    // Too short.
    { start_us: 60_000_000, end_us: 66_000_000, title: "Short", reasons: [] },
    // Too long.
    { start_us: 0, end_us: 90_000_000, title: "Long", reasons: [] },
    // Nowhere near speech.
    { start_us: 500_000_000, end_us: 540_000_000, title: "Far", reasons: [] },
    // No title.
    { start_us: 45_000_000, end_us: 70_000_000, title: " ", reasons: [] },
  ]);
  assert.equal(result.candidates.length, 1);
  const [clip] = result.candidates;
  // Edges land on sentence edges: the first word of "Here is how..." and
  // the last word of a sentence ending in "minutes.".
  const sentenceStarts = splitSentences(words).map((s) => s.startUs);
  const sentenceEnds = splitSentences(words).map((s) => s.endUs);
  assert.ok(sentenceStarts.includes(clip!.startUs));
  assert.ok(sentenceEnds.includes(clip!.endUs));
  assert.equal(clip!.origin, "ai");
  assert.equal(clip!.title, "The best demo tip");
  assert.equal(clip!.id, `clip-${clip!.startUs}-${clip!.endUs}`);
  assert.equal(clip!.reasons.length, 4);
  assert.ok(clip!.reasons.every((reason) => reason.length <= 80 && reason));
  assert.ok(clip!.excerpt.length <= 221 && clip!.excerpt.startsWith("Here"));
  assert.equal(result.rejected.length, 5);
  assert.match(result.rejected[0]!, /^Clip 2: .*overlaps/u);
  assert.match(result.rejected[1]!, /^Clip 3: .*clips must be 15 to 60 s/u);
  assert.match(result.rejected[3]!, /^Clip 5: .*sentences start and end/u);
  assert.match(result.rejected[4]!, /^Clip 6: .*title/u);
});

test("at most six clips are kept, strongest first, in time order", () => {
  const words = paragraph(
    "Here is how to record a clean demo of your app in minutes.",
    60,
    0,
  ).words;
  const proposals = Array.from({ length: 7 }, (_, index) => ({
    start_us: index * 40_000_000 + 1_000_000,
    end_us: index * 40_000_000 + 31_000_000,
    title: `Clip ${index}`,
    reasons: [],
  })).reverse();
  const result = proposeShortCandidates(words, proposals);
  assert.equal(result.candidates.length, 6);
  assert.deepEqual(
    result.candidates.map((clip) => clip.startUs),
    [...result.candidates.map((clip) => clip.startUs)].sort((a, b) => a - b),
  );
  // The first proposal ranks highest.
  assert.ok(
    result.candidates.find((clip) => clip.title === "Clip 6")!.score >
      result.candidates.find((clip) => clip.title === "Clip 1")!.score,
  );
  assert.equal(result.rejected.length, 1);
  assert.match(result.rejected[0]!, /at most 6/u);
});
