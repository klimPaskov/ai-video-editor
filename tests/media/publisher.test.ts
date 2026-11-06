import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import type { CaptionWord } from "../../packages/domain/src/captions.ts";
import {
  assertPublishView,
  transcriptSections,
  type PublishRequest,
} from "../../packages/domain/src/publish.ts";
import {
  organizedFolder,
  Publisher,
  safeFolderName,
  writerPrompt,
  type PublishContext,
} from "../../apps/desktop/src/publish.ts";

const second = 1_000_000;

function talk(seconds: number): CaptionWord[] {
  const words: CaptionWord[] = [];
  const sentence = ["The", "focus", "tree", "needs", "balance."];
  for (let at = 0; at + 3 <= seconds; at += 3)
    sentence.forEach((text, index) =>
      words.push({
        text,
        startUs: at * second + index * 500_000,
        endUs: at * second + index * 500_000 + 400_000,
      }),
    );
  return words;
}

async function fixture(
  write?: (prompt: string) => Promise<string | null>,
): Promise<{
  publisher: Publisher;
  videos: string;
  copied: string[];
  pages: string[];
  shown: string[];
  prompts: string[];
}> {
  const base = resolve("test-results/publisher");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, "fixture-"));
  const videos = join(root, "Videos");
  const copied: string[] = [];
  const pages: string[] = [];
  const shown: string[] = [];
  const prompts: string[] = [];
  const context = async (request: PublishRequest): Promise<PublishContext> =>
    request.kind === "video"
      ? {
          projectName: "Chaos Redux: trailer?",
          name: "Chaos Redux trailer",
          durationUs: 400 * second,
          words: talk(400),
        }
      : {
          projectName: "Chaos Redux: trailer?",
          name: "The focus tree that broke my mod",
          durationUs: 40 * second,
          words: talk(40),
        };
  const publisher = new Publisher({
    root: join(root, "app"),
    videos: () => videos,
    context,
    ...(write
      ? {
          write: async (prompt: string) => {
            prompts.push(prompt);
            return write(prompt);
          },
        }
      : {}),
    now: () => "2026-11-06T10:00:00.000Z",
    copy: (text) => copied.push(text),
    openPage: async (url) => {
      pages.push(url);
    },
    reveal: (target) => shown.push(target),
  });
  return { publisher, videos, copied, pages, shown, prompts };
}

const video: PublishRequest = {
  schema_version: "1.0",
  project_id: "project-1",
  kind: "video",
  subject_id: "project-1",
};
const short: PublishRequest = {
  schema_version: "1.0",
  project_id: "project-1",
  kind: "short",
  subject_id: "clip-1",
  tone: "funny",
};

test("everything made for a project lives in one tidy folder", () => {
  assert.equal(safeFolderName('Chaos: Redux? <v2>/"x"'), "Chaos Redux v2 x");
  assert.equal(safeFolderName("ends with dots..."), "ends with dots");
  assert.equal(safeFolderName("con"), "Untitled");
  assert.equal(safeFolderName("   "), "Untitled");
  assert.equal(
    organizedFolder("/v", "My project", "Shorts"),
    join("/v", "Urushi", "My project", "Shorts"),
  );
});

test("without a model the plain text is drafted and saved in the Publish folder", async () => {
  const { publisher, videos } = await fixture();
  assert.equal((await publisher.view(video)).kit, null);
  const view = await publisher.draft(video);
  assertPublishView(view);
  assert.equal(view.kit!.writtenBy, "draft");
  assert.match(view.message!, /Connect Claude or an API provider/u);
  const folder = join(videos, "Urushi", "Chaos Redux trailer", "Publish");
  assert.equal(view.folder, folder);
  assert.deepEqual((await readdir(folder)).sort(), [
    "youtube.json",
    "youtube.md",
  ]);
  const text = await readFile(join(folder, "youtube.md"), "utf8");
  assert.match(text, /## Description/u);
  assert.match(text, /\n0:00 /u);
  const stored = await publisher.view(video);
  assert.equal(stored.kit!.youtube.title, "Chaos Redux trailer");
});

test("a connected model words the text and cannot move a timestamp", async () => {
  const sectionsStarts = transcriptSections(talk(400), 400 * second).map(
    (section) => section.startUs,
  );
  const { publisher, prompts } = await fixture(async () =>
    JSON.stringify({
      titles: ["A better title", "Another idea"],
      intro: "What this trailer is.",
      chapterTitles: sectionsStarts.map((_, index) => `Part ${index + 1}`),
      tags: ["hoi4"],
      x: "Posted.",
      redditTitle: "Reddit",
      redditBody: "Body",
      linkedin: "LinkedIn",
      discord: "Discord",
    }),
  );
  const view = await publisher.draft({ ...video, tone: "professional" });
  assert.equal(view.kit!.writtenBy, "provider");
  assert.equal(view.kit!.tone, "professional");
  assert.equal(view.kit!.youtube.title, "A better title");
  assert.deepEqual(
    view.kit!.youtube.chapters.map((chapter) => chapter.startUs),
    sectionsStarts,
  );
  // The model is told the sections and not to invent timestamps.
  assert.match(prompts[0]!, /exactly \d+ short titles/u);
  assert.match(prompts[0]!, /Do not invent timestamps/u);
  assert.match(prompts[0]!, /professional/u);
});

test("an unusable model answer, or a model that is down, leaves the plain version", async () => {
  const junk = await fixture(async () => "sorry, I cannot do that");
  const first = await junk.publisher.draft(video);
  assert.equal(first.kit!.writtenBy, "draft");
  assert.match(first.message!, /could not be used/u);
  const down = await fixture(async () => {
    throw new Error("offline");
  });
  const second = await down.publisher.draft(video);
  assert.equal(second.kit!.writtenBy, "draft");
});

test("a short gets its own title, hashtags and file under Publish/Shorts", async () => {
  const { publisher, videos } = await fixture();
  const view = await publisher.draft(short);
  assert.equal(view.kit!.subject.kind, "short");
  assert.equal(view.kit!.tone, "funny");
  assert.deepEqual(view.kit!.youtube.chapters, []);
  const folder = join(
    videos,
    "Urushi",
    "Chaos Redux trailer",
    "Publish",
    "Shorts",
  );
  assert.equal(view.folder, folder);
  assert.deepEqual((await readdir(folder)).sort(), [
    "The focus tree that broke my mod.json",
    "The focus tree that broke my mod.md",
  ]);
});

test("edits are kept, checked and written back to the files", async () => {
  const { publisher, videos } = await fixture();
  const view = await publisher.draft(video);
  const edited = {
    ...view.kit!,
    youtube: { ...view.kit!.youtube, title: "My own title" },
  };
  const saved = await publisher.save(video, edited);
  assert.equal(saved.message, "Saved.");
  assert.equal(
    (await publisher.view(video)).kit!.youtube.title,
    "My own title",
  );
  const text = await readFile(
    join(videos, "Urushi", "Chaos Redux trailer", "Publish", "youtube.md"),
    "utf8",
  );
  assert.match(text, /^# My own title/u);
  await assert.rejects(
    publisher.save(video, {
      ...edited,
      youtube: { ...edited.youtube, title: "t".repeat(101) },
    }),
    /at most 100 characters/u,
  );
  await assert.rejects(
    publisher.save(short, edited),
    /belongs to something else/u,
  );
});

test("Open YouTube copies the text, opens the upload page and shows the folder", async () => {
  const { publisher, copied, pages, shown } = await fixture();
  const early = await publisher.openStudio(video);
  assert.equal(early.message, "Write the text first.");
  assert.deepEqual(pages, []);
  const view = await publisher.draft(video);
  const done = await publisher.openStudio(video);
  assert.match(done.message!, /copied/u);
  assert.deepEqual(pages, ["https://www.youtube.com/upload"]);
  assert.equal(shown.at(-1), view.folder);
  assert.ok(copied[0]!.startsWith("Chaos Redux trailer\n\n"));
  assert.match(copied[0]!, /\nChapters\n0:00 /u);
});

test("the writer prompt carries the sections and the tone", () => {
  const sections = transcriptSections(talk(400), 400 * second);
  const prompt = writerPrompt(
    {
      schema_version: "1.0",
      subject: { kind: "short", id: "c", name: "N", durationUs: 30 * second },
      tone: "funny",
      writtenBy: "draft",
      youtube: {
        title: "N",
        titleIdeas: [],
        intro: "",
        chapters: [],
        tags: [],
      },
      posts: {
        x: "",
        redditTitle: "",
        redditBody: "",
        linkedin: "",
        discord: "",
      },
      updatedAt: "x",
    },
    sections,
    "hello",
  );
  assert.match(prompt, /YouTube Short/u);
  assert.match(prompt, /funny/u);
  assert.match(
    prompt,
    new RegExp(`exactly ${sections.length} short titles`, "u"),
  );
});

test("an edited short keeps its title and tags and rewrites its file", async () => {
  const { publisher, videos } = await fixture();
  const view = await publisher.draft(short);
  const edited = {
    ...view.kit!,
    youtube: {
      ...view.kit!.youtube,
      title: "My own short title",
      tags: ["hoi4", "mod", "shorts"],
    },
  };
  const saved = await publisher.save(short, edited);
  assert.equal(saved.message, "Saved.");
  const text = await readFile(
    join(
      videos,
      "Urushi",
      "Chaos Redux trailer",
      "Publish",
      "Shorts",
      "The focus tree that broke my mod.md",
    ),
    "utf8",
  );
  assert.match(text, /^# My own short title/u);
  assert.match(text, /hoi4, mod, shorts/u);
});
