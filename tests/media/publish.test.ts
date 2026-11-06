import assert from "node:assert/strict";
import test from "node:test";
import type { CaptionWord } from "../../packages/domain/src/captions.ts";
import {
  applyWrittenText,
  assertPublishKit,
  assertPublishThumbnailRequest,
  chapterLines,
  cleanTags,
  draftKit,
  formatTimestamp,
  keywordTags,
  normalizeChapters,
  parseWrittenText,
  transcriptSections,
  youtubeDescription,
} from "../../packages/domain/src/publish.ts";

const second = 1_000_000;

/** A talk of `seconds` seconds: a five-word sentence every three seconds. */
function talk(seconds: number): CaptionWord[] {
  const words: CaptionWord[] = [];
  const sentence = ["The", "focus", "tree", "needs", "balance."];
  for (let at = 0; at + 3 <= seconds; at += 3)
    sentence.forEach((text, index) =>
      words.push({
        text: index === 0 && at % 6 === 0 ? "Today" : text,
        startUs: at * second + index * 500_000,
        endUs: at * second + index * 500_000 + 400_000,
      }),
    );
  return words;
}

test("timestamps read like YouTube chapters", () => {
  assert.equal(formatTimestamp(0), "0:00");
  assert.equal(formatTimestamp(65 * second), "1:05");
  assert.equal(formatTimestamp(3_725 * second), "1:02:05");
});

test("chapters start at 0:00, stay ten seconds apart and need three", () => {
  const good = normalizeChapters(
    [
      { startUs: 4 * second, title: "Intro" },
      { startUs: 60 * second, title: "Middle" },
      { startUs: 62 * second, title: "Too close" },
      { startUs: 120 * second, title: "End" },
    ],
    180 * second,
  );
  assert.deepEqual(
    good.map((chapter) => [chapter.startUs / second, chapter.title]),
    [
      [0, "Intro"],
      [60, "Middle"],
      [120, "End"],
    ],
  );
  assert.deepEqual(chapterLines(good), [
    "0:00 Intro",
    "1:00 Middle",
    "2:00 End",
  ]);
  // Two chapters are not a list YouTube would use.
  assert.deepEqual(
    normalizeChapters(
      [
        { startUs: 0, title: "A" },
        { startUs: 60 * second, title: "B" },
      ],
      180 * second,
    ),
    [],
  );
  // One too close to the end of the video is dropped.
  assert.equal(
    normalizeChapters(
      [
        { startUs: 0, title: "A" },
        { startUs: 50 * second, title: "B" },
        { startUs: 100 * second, title: "C" },
        { startUs: 175 * second, title: "D" },
      ],
      180 * second,
    ).length,
    3,
  );
});

test("sections begin at sentence starts about a minute and a half apart", () => {
  const words = talk(400);
  const sections = transcriptSections(words, 400 * second);
  assert.ok(sections.length >= 3 && sections.length <= 12);
  assert.equal(sections[0]!.startUs, 0);
  for (const [position, section] of sections.slice(1).entries()) {
    assert.ok(
      section.startUs - sections[position]!.startUs >= 10 * second,
      "chapters at least ten seconds apart",
    );
    // Starts on the first word of a sentence.
    assert.ok(
      words.some((word) => word.startUs === section.startUs),
      `section ${position + 1} starts on a spoken word`,
    );
  }
  assert.deepEqual(transcriptSections([], 400 * second), []);
  assert.deepEqual(transcriptSections(words, 20 * second), []);
});

test("tags follow YouTube's rules", () => {
  const tags = cleanTags([
    "AI video editor",
    "ai video editor",
    "a, b <c>",
    "x".repeat(60),
    "",
    ...Array.from({ length: 40 }, (_, index) => `tag number ${index}`),
  ]);
  assert.ok(tags.length <= 15);
  assert.ok(tags.every((tag) => tag.length <= 30 && !/[<>,]/u.test(tag)));
  assert.equal(
    tags.filter((tag) => tag.toLowerCase() === "ai video editor").length,
    1,
  );
  assert.ok(tags.join(",").length <= 450);
  assert.deepEqual([...keywordTags(talk(60))].sort(), [
    "balance",
    "focus",
    "needs",
    "today",
    "tree",
  ]);
});

test("the plain kit works with no model: chapters, tags, posts within limits", () => {
  const kit = draftKit({
    kind: "video",
    id: "project-1",
    name: "Chaos Redux trailer",
    durationUs: 400 * second,
    tone: "casual",
    words: talk(400),
    now: "2026-11-06T10:00:00.000Z",
  });
  assert.equal(kit.writtenBy, "draft");
  assert.equal(kit.youtube.title, "Chaos Redux trailer");
  assert.ok(kit.youtube.chapters.length >= 3);
  assert.equal(kit.youtube.chapters[0]!.startUs, 0);
  assert.ok(kit.posts.x.length <= 280);
  assert.match(youtubeDescription(kit), /\nChapters\n0:00 /u);
  assertPublishKit(kit);
  // A short has no chapters and gains hashtags.
  const short = draftKit({
    kind: "short",
    id: "clip-1",
    name: "The focus tree",
    durationUs: 40 * second,
    tone: "funny",
    words: talk(40),
    now: "2026-11-06T10:00:00.000Z",
  });
  assert.deepEqual(short.youtube.chapters, []);
  assert.match(youtubeDescription(short), /#shorts$/u);
  assertPublishKit(short);
});

test("a model's wording is used but timestamps stay the transcript's", () => {
  const words = talk(400);
  const base = draftKit({
    kind: "video",
    id: "project-1",
    name: "Chaos Redux trailer",
    durationUs: 400 * second,
    tone: "casual",
    words,
    now: "2026-11-06T10:00:00.000Z",
  });
  const sections = transcriptSections(words, 400 * second);
  const written = parseWrittenText(
    `Here you go:\n${JSON.stringify({
      titles: ["Better title", "Second idea"],
      intro: "Why this trailer exists.",
      chapterTitles: sections.map((_, index) => `Chapter ${index + 1}`),
      tags: ["hoi4", "mod"],
      x: "x".repeat(400),
      redditTitle: "Reddit title",
      redditBody: "Body",
      linkedin: "LinkedIn",
      discord: "Discord",
    })}`,
  );
  assert.ok(written);
  assert.equal(written.x.length <= 280, true);
  const kit = applyWrittenText(base, written, sections);
  assert.equal(kit.writtenBy, "provider");
  assert.equal(kit.youtube.title, "Better title");
  assert.deepEqual(kit.youtube.titleIdeas, ["Second idea"]);
  assert.deepEqual(
    kit.youtube.chapters.map((chapter) => chapter.startUs),
    base.youtube.chapters.map((chapter) => chapter.startUs),
  );
  assert.equal(kit.youtube.chapters[1]!.title, "Chapter 2");
  assertPublishKit(kit);
  // Too few chapter titles: the plain ones stay.
  const fewer = applyWrittenText(
    base,
    { ...written, chapterTitles: ["Only one"] },
    sections,
  );
  assert.deepEqual(fewer.youtube.chapters, base.youtube.chapters);
});

test("unusable model replies are refused and over-long text is caught", () => {
  assert.equal(parseWrittenText("no json here"), null);
  assert.equal(parseWrittenText('{"titles": []}'), null);
  assert.equal(parseWrittenText("{broken"), null);
  const kit = draftKit({
    kind: "video",
    id: "p",
    name: "N",
    durationUs: 100 * second,
    tone: "casual",
    words: talk(100),
    now: "2026-11-06T10:00:00.000Z",
  });
  assert.throws(
    () =>
      assertPublishKit({
        ...kit,
        youtube: { ...kit.youtube, title: "t".repeat(101) },
      }),
    /at most 100 characters/u,
  );
  assert.throws(
    () =>
      assertPublishKit({ ...kit, posts: { ...kit.posts, x: "x".repeat(281) } }),
    /280/u,
  );
  assert.throws(
    () =>
      assertPublishKit({
        ...kit,
        youtube: {
          ...kit.youtube,
          chapters: [
            { startUs: 5 * second, title: "late" },
            { startUs: 30 * second, title: "b" },
            { startUs: 60 * second, title: "c" },
          ],
        },
      }),
    /0:00/u,
  );
});

test("a thumbnail request is for a video and carries a bounded base64 JPEG", () => {
  const base = {
    schema_version: "1.0",
    project_id: "project-1",
    kind: "video",
    subject_id: "project-1",
    jpeg_base64: "/9j/4AAQ",
  };
  assertPublishThumbnailRequest(base);
  for (const wrong of [
    { ...base, kind: "short" },
    { ...base, jpeg_base64: "" },
    { ...base, jpeg_base64: "not base64!" },
    { ...base, jpeg_base64: "A".repeat(3_000_000) },
    { ...base, extra: 1 },
    { ...base, jpeg_base64: undefined },
  ])
    assert.throws(() => assertPublishThumbnailRequest(wrong));
});
