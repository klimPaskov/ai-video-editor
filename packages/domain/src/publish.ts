/**
 * Publishing text for a finished video or a short clip: YouTube title,
 * description with exact chapter timestamps, tags, and posts for X, Reddit
 * and others. Timestamps always come from the real timeline and transcript
 * (never from a model); a model only words titles, the description and posts.
 * Without any provider connected a plain draft is made from the transcript.
 */
import type { CaptionWord } from "./captions.ts";

export type PublishTone = "casual" | "professional" | "funny";
export const publishTones: readonly PublishTone[] = [
  "casual",
  "professional",
  "funny",
];

export interface Chapter {
  startUs: number;
  title: string;
}

export interface YoutubeText {
  title: string;
  /** Other titles the person can pick from. */
  titleIdeas: string[];
  /** The description above the chapters. */
  intro: string;
  chapters: Chapter[];
  tags: string[];
}

export interface PublishPosts {
  x: string;
  redditTitle: string;
  redditBody: string;
  linkedin: string;
  discord: string;
}

export interface PublishKit {
  schema_version: "1.0";
  subject: {
    kind: "video" | "short";
    id: string;
    name: string;
    durationUs: number;
  };
  tone: PublishTone;
  /** "provider" when a connected model worded it, "draft" for the plain version. */
  writtenBy: "provider" | "draft";
  youtube: YoutubeText;
  posts: PublishPosts;
  updatedAt: string;
}

/** YouTube's limits, kept a little inside so a paste never fails. */
export const publishLimits = Object.freeze({
  title: 100,
  description: 4800,
  tag: 30,
  tags: 15,
  tagsTotal: 450,
  x: 280,
  redditTitle: 300,
  redditBody: 8000,
  post: 3000,
  /** YouTube needs at least three chapters, each at least ten seconds long. */
  minimumChapters: 3,
  chapterGapUs: 10_000_000,
});

export function formatTimestamp(us: number): string {
  const total = Math.max(0, Math.floor(us / 1_000_000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const two = (value: number) => String(value).padStart(2, "0");
  return hours > 0
    ? `${hours}:${two(minutes)}:${two(seconds)}`
    : `${minutes}:${two(seconds)}`;
}

/**
 * Chapters YouTube will accept: sorted, the first at 0:00, each at least ten
 * seconds after the one before and inside the video, and at least three.
 * Otherwise none (YouTube then ignores the list).
 */
export function normalizeChapters(
  chapters: readonly Chapter[],
  durationUs: number,
): Chapter[] {
  const sorted = [...chapters]
    .filter(
      (chapter) =>
        Number.isFinite(chapter.startUs) &&
        chapter.startUs >= 0 &&
        chapter.startUs < durationUs &&
        chapter.title.trim().length > 0,
    )
    .sort((a, b) => a.startUs - b.startUs);
  if (sorted.length === 0) return [];
  const kept: Chapter[] = [
    { startUs: 0, title: sorted[0]!.title.trim().slice(0, 80) },
  ];
  for (const chapter of sorted.slice(1)) {
    const last = kept.at(-1)!;
    if (
      chapter.startUs - last.startUs >= publishLimits.chapterGapUs &&
      durationUs - chapter.startUs >= publishLimits.chapterGapUs
    )
      kept.push({
        startUs: Math.floor(chapter.startUs / 1_000_000) * 1_000_000,
        title: chapter.title.trim().slice(0, 80),
      });
  }
  return kept.length >= publishLimits.minimumChapters ? kept : [];
}

export function chapterLines(chapters: readonly Chapter[]): string[] {
  return chapters.map(
    (chapter) => `${formatTimestamp(chapter.startUs)} ${chapter.title}`,
  );
}

/** The description as pasted into YouTube: the intro, then the chapters. */
export function youtubeDescription(kit: PublishKit): string {
  const lines = [kit.youtube.intro.trim()];
  if (kit.subject.kind === "video" && kit.youtube.chapters.length > 0)
    lines.push("", "Chapters", ...chapterLines(kit.youtube.chapters));
  if (kit.subject.kind === "short") {
    const hashtags = kit.youtube.tags
      .slice(0, 3)
      .map((tag) => `#${tag.replaceAll(/\s+/gu, "")}`);
    if (!hashtags.includes("#shorts")) hashtags.push("#shorts");
    lines.push("", hashtags.join(" "));
  }
  return lines.join("\n").slice(0, publishLimits.description);
}

/** Tags clipped to YouTube's rules: short, no commas or angle brackets, within the total. */
export function cleanTags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  let total = 0;
  for (const raw of tags) {
    const tag = raw
      .replaceAll(/[<>,]/gu, " ")
      .replaceAll(/\s+/gu, " ")
      .trim()
      .slice(0, publishLimits.tag)
      .trim();
    const key = tag.toLowerCase();
    if (!tag || seen.has(key)) continue;
    if (out.length >= publishLimits.tags) break;
    if (total + tag.length + 1 > publishLimits.tagsTotal) break;
    seen.add(key);
    out.push(tag);
    total += tag.length + 1;
  }
  return out;
}

export interface TranscriptSection {
  startUs: number;
  /** The words spoken in the section (the start of it), for titles. */
  text: string;
}

/**
 * Sections of the talk at sentence starts, about ninety seconds apart (at
 * least ten), so chapters begin where a thought begins.
 */
export function transcriptSections(
  words: readonly CaptionWord[],
  durationUs: number,
): TranscriptSection[] {
  if (words.length === 0 || durationUs < 3 * publishLimits.chapterGapUs)
    return [];
  const sentenceStarts: number[] = [0];
  for (let index = 1; index < words.length; index++) {
    const before = words[index - 1]!;
    if (
      /[.!?]$/u.test(before.text.trim()) ||
      words[index]!.startUs - before.endUs > 900_000
    )
      sentenceStarts.push(index);
  }
  const target = Math.min(12, Math.max(3, Math.round(durationUs / 90_000_000)));
  const spacing = Math.max(publishLimits.chapterGapUs, durationUs / target);
  const starts: number[] = [0];
  for (const index of sentenceStarts.slice(1)) {
    const at = words[index]!.startUs;
    if (at - words[starts.at(-1)!]!.startUs >= spacing) starts.push(index);
  }
  return starts.map((start, position) => {
    const end = starts[position + 1] ?? words.length;
    return {
      startUs: position === 0 ? 0 : words[start]!.startUs,
      text: words
        .slice(start, Math.min(end, start + 60))
        .map((word) => word.text)
        .join(" ")
        .replaceAll(/\s+/gu, " ")
        .trim(),
    };
  });
}

/** A plain chapter title from the section's opening words. */
export function fallbackChapterTitle(text: string, position: number): string {
  const opening = text
    .replaceAll(/[^\p{L}\p{N}' -]/gu, "")
    .split(/\s+/u)
    .filter(Boolean)
    .slice(0, 5)
    .join(" ");
  if (!opening) return position === 0 ? "Intro" : `Part ${position + 1}`;
  return opening.charAt(0).toUpperCase() + opening.slice(1);
}

const stopWords = new Set(
  "about after again also and are because been before being but can could did does doing done for from get got had has have here how into just like make more most much not now one only other our out over really right see she some such than that the their them then there these they this those through very was way well were what when where which while who will with would you your yours".split(
    " ",
  ),
);

/** The words said most, for tags when no model is available. */
export function keywordTags(
  words: readonly CaptionWord[],
  limit = 8,
): string[] {
  const counts = new Map<string, number>();
  for (const word of words) {
    const text = word.text.toLowerCase().replaceAll(/[^\p{L}\p{N}]/gu, "");
    if (text.length < 4 || stopWords.has(text) || /^\d+$/u.test(text)) continue;
    counts.set(text, (counts.get(text) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([text]) => text);
}

export interface KitInput {
  kind: "video" | "short";
  id: string;
  name: string;
  durationUs: number;
  tone: PublishTone;
  words: readonly CaptionWord[];
  now: string;
}

function clip(text: string, limit: number): string {
  const clean = text.replaceAll(/\s+/gu, " ").trim();
  return clean.length <= limit
    ? clean
    : `${clean.slice(0, limit - 1).trimEnd()}…`;
}

/** Like clip, but keeps paragraph breaks (posts are written in paragraphs). */
function clipPost(text: string, limit: number): string {
  const clean = text
    .split("\n")
    .map((line) => line.replaceAll(/[ \t]+/gu, " ").trim())
    .join("\n")
    .replaceAll(/\n{3,}/gu, "\n\n")
    .trim();
  return clean.length <= limit
    ? clean
    : `${clean.slice(0, limit - 1).trimEnd()}…`;
}

function postsFor(
  tone: PublishTone,
  title: string,
  minutes: number,
  spoken: string,
): PublishPosts {
  const length = minutes >= 1 ? `${Math.round(minutes)} minute` : "short";
  const opening: Record<PublishTone, string> = {
    casual: `Made a ${length} video: ${title}.`,
    professional: `New video: ${title}.`,
    funny: `I made a ${length} video so you don't have to watch the footage: ${title}.`,
  };
  const quote = (limit: number): string =>
    spoken ? `\n\n"${clip(spoken, limit)}"` : "";
  return {
    x: clipPost(`${opening[tone]} Link below.`, publishLimits.x),
    redditTitle: clip(title, publishLimits.redditTitle),
    redditBody: clipPost(
      `${opening[tone]}${quote(220)}\n\nWhat do you think, and what would you change?`,
      publishLimits.redditBody,
    ),
    linkedin: clipPost(
      `${opening[tone]}${quote(160)}\n\nHow do you approach this? I would like to hear.`,
      publishLimits.post,
    ),
    discord: clipPost(
      `${opening[tone]} Feedback welcome in this thread.`,
      publishLimits.post,
    ),
  };
}

/** The plain version, from the project's name and transcript; no model involved. */
export function draftKit(input: KitInput): PublishKit {
  const sections =
    input.kind === "video"
      ? transcriptSections(input.words, input.durationUs)
      : [];
  const chapters = normalizeChapters(
    sections.map((section, position) => ({
      startUs: section.startUs,
      title: fallbackChapterTitle(section.text, position),
    })),
    input.durationUs,
  );
  const title = clip(input.name, publishLimits.title) || "My video";
  const spoken = input.words
    .map((word) => word.text)
    .join(" ")
    .replaceAll(/\s+/gu, " ")
    .trim();
  return {
    schema_version: "1.0",
    subject: {
      kind: input.kind,
      id: input.id,
      name: input.name,
      durationUs: input.durationUs,
    },
    tone: input.tone,
    writtenBy: "draft",
    youtube: {
      title,
      titleIdeas: [],
      intro: clip(spoken, 280) || title,
      chapters,
      tags: cleanTags(keywordTags(input.words)),
    },
    posts: postsFor(input.tone, title, input.durationUs / 60_000_000, spoken),
    updatedAt: input.now,
  };
}

/** What a model is asked to return (sections are given, so timestamps cannot drift). */
export interface WrittenText {
  titles: string[];
  intro: string;
  chapterTitles: string[];
  tags: string[];
  x: string;
  redditTitle: string;
  redditBody: string;
  linkedin: string;
  discord: string;
}

function textOf(value: unknown, limit: number): string {
  return typeof value === "string" ? clip(value, limit) : "";
}

/** Reads a model's JSON reply into text; null when it is not usable. */
export function parseWrittenText(raw: string): WrittenText | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
  const list = (item: unknown, limit: number, count: number): string[] =>
    Array.isArray(item)
      ? item
          .map((entry) => textOf(entry, limit))
          .filter(Boolean)
          .slice(0, count)
      : [];
  const titles = list(value.titles, publishLimits.title, 5);
  if (titles.length === 0) return null;
  return {
    titles,
    intro: textOf(value.intro, 2000),
    chapterTitles: list(value.chapterTitles, 80, 14),
    tags: list(value.tags, publishLimits.tag, 20),
    x: textOf(value.x, publishLimits.x),
    redditTitle: textOf(value.redditTitle, publishLimits.redditTitle),
    redditBody: textOf(value.redditBody, publishLimits.redditBody),
    linkedin: textOf(value.linkedin, publishLimits.post),
    discord: textOf(value.discord, publishLimits.post),
  };
}

/**
 * Puts a model's wording into the plain kit. Chapter timestamps stay the
 * ones taken from the transcript; titles replace the plain ones only when
 * the model gave one for every section.
 */
export function applyWrittenText(
  base: PublishKit,
  written: WrittenText,
  sections: readonly TranscriptSection[],
): PublishKit {
  const chapters =
    written.chapterTitles.length === sections.length
      ? normalizeChapters(
          sections.map((section, position) => ({
            startUs: section.startUs,
            title: written.chapterTitles[position]!,
          })),
          base.subject.durationUs,
        )
      : base.youtube.chapters;
  const tags = cleanTags([...written.tags, ...base.youtube.tags]);
  return {
    ...base,
    writtenBy: "provider",
    youtube: {
      title: written.titles[0]!,
      titleIdeas: written.titles.slice(1),
      intro: written.intro || base.youtube.intro,
      chapters: chapters.length > 0 ? chapters : base.youtube.chapters,
      tags: tags.length > 0 ? tags : base.youtube.tags,
    },
    posts: {
      x: written.x || base.posts.x,
      redditTitle: written.redditTitle || base.posts.redditTitle,
      redditBody: written.redditBody || base.posts.redditBody,
      linkedin: written.linkedin || base.posts.linkedin,
      discord: written.discord || base.posts.discord,
    },
  };
}

/** Throws a plain sentence when text is too long for where it goes. */
export function assertPublishKit(value: unknown): asserts value is PublishKit {
  const bad = (message: string): never => {
    throw new Error(message);
  };
  if (!value || typeof value !== "object")
    return bad("Publish text could not be read.");
  const kit = value as PublishKit;
  if (kit.schema_version !== "1.0") bad("Publish text could not be read.");
  if (!kit.subject || !["video", "short"].includes(kit.subject.kind))
    bad("Publish text could not be read.");
  if (!publishTones.includes(kit.tone)) bad("Choose a tone.");
  if (
    typeof kit.youtube?.title !== "string" ||
    kit.youtube.title.length > publishLimits.title
  )
    bad(`The title can be at most ${publishLimits.title} characters.`);
  if (youtubeDescription(kit).length > publishLimits.description)
    bad("The description is too long for YouTube.");
  if (
    !Array.isArray(kit.youtube.tags) ||
    cleanTags(kit.youtube.tags).length !== kit.youtube.tags.length
  )
    bad("The tags are not valid for YouTube.");
  if (typeof kit.posts?.x !== "string" || kit.posts.x.length > publishLimits.x)
    bad(`An X post can be at most ${publishLimits.x} characters.`);
  if (kit.posts.redditTitle.length > publishLimits.redditTitle)
    bad("The Reddit title is too long.");
  if (kit.youtube.chapters.length > 0) {
    const fixed = normalizeChapters(
      kit.youtube.chapters,
      kit.subject.durationUs,
    );
    if (
      fixed.length !== kit.youtube.chapters.length ||
      fixed.some(
        (chapter, index) =>
          chapter.startUs !== kit.youtube.chapters[index]!.startUs,
      )
    )
      bad(
        "Chapters need to start at 0:00, be at least 10 seconds apart and be at least three.",
      );
  }
}

/** Asks for the publishing text of a project's video or one of its short clips. */
export interface PublishRequest {
  schema_version: "1.0";
  project_id: string;
  kind: "video" | "short";
  /** The project's id for a video, the clip's id for a short. */
  subject_id: string;
  /** Wording to draft in; the saved kit's tone when absent. */
  tone?: PublishTone;
}

export interface PublishView {
  /** Null until text has been drafted. */
  kit: PublishKit | null;
  /** The folder the text is saved in, once there is any. */
  folder: string | null;
  /** A plain sentence about what just happened, or null. */
  message: string | null;
}

const idShape = /^[A-Za-z0-9_-]{1,80}$/u;

export function assertPublishRequest(
  value: unknown,
): asserts value is PublishRequest {
  const request = value as PublishRequest | null;
  const keys = request ? Object.keys(request) : [];
  const ok =
    !!request &&
    typeof request === "object" &&
    keys.every((key) =>
      ["schema_version", "project_id", "kind", "subject_id", "tone"].includes(
        key,
      ),
    ) &&
    request.schema_version === "1.0" &&
    idShape.test(request.project_id) &&
    (request.kind === "video" || request.kind === "short") &&
    idShape.test(request.subject_id) &&
    (request.tone === undefined || publishTones.includes(request.tone));
  if (!ok) throw new Error("Publish request could not be read.");
}

export function assertPublishView(
  value: unknown,
): asserts value is PublishView {
  const view = value as PublishView | null;
  const ok =
    !!view &&
    typeof view === "object" &&
    Object.keys(view).sort().join() === "folder,kit,message" &&
    (view.folder === null || typeof view.folder === "string") &&
    (view.message === null || typeof view.message === "string");
  if (!ok) throw new Error("Publish view could not be read.");
  if (view.kit !== null) assertPublishKit(view.kit);
}

/** Saves the person's edits to the text of one video or short. */
export interface PublishSaveRequest extends PublishRequest {
  kit: PublishKit;
}

export function assertPublishSaveRequest(
  value: unknown,
): asserts value is PublishSaveRequest {
  if (!value || typeof value !== "object" || !("kit" in value))
    throw new Error("Publish request could not be read.");
  const { kit, ...request } = value as PublishSaveRequest;
  assertPublishRequest(request);
  assertPublishKit(kit);
}

/** YouTube accepts thumbnails up to 2 MB; 1280 by 720 JPEG stays well inside. */
export const thumbnailLimits = Object.freeze({
  bytes: 2 * 1024 * 1024,
  width: 1280,
  height: 720,
});

/** Saves the composed thumbnail of a finished video as a JPEG. */
export interface PublishThumbnailRequest extends PublishRequest {
  jpeg_base64: string;
}

export function assertPublishThumbnailRequest(
  value: unknown,
): asserts value is PublishThumbnailRequest {
  if (!value || typeof value !== "object" || !("jpeg_base64" in value))
    throw new Error("Thumbnail request could not be read.");
  const { jpeg_base64: data, ...request } = value as PublishThumbnailRequest;
  assertPublishRequest(request);
  if (
    request.kind !== "video" ||
    typeof data !== "string" ||
    data.length === 0 ||
    data.length > Math.ceil((thumbnailLimits.bytes * 4) / 3) + 8 ||
    !/^[A-Za-z0-9+/]+={0,2}$/u.test(data)
  )
    throw new Error("Thumbnail request could not be read.");
}
