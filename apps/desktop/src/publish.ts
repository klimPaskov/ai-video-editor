import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CaptionWord } from "../../../packages/domain/src/captions.ts";
import {
  applyWrittenText,
  assertPublishKit,
  chapterLines,
  draftKit,
  parseWrittenText,
  publishLimits,
  publishTones,
  thumbnailLimits,
  transcriptSections,
  youtubeDescription,
  type PublishKit,
  type PublishRequest,
  type PublishTone,
  type PublishView,
  type TranscriptSection,
} from "../../../packages/domain/src/publish.ts";

/** A name that is safe as a folder or file name on Windows, macOS and Linux. */
export function safeFolderName(name: string): string {
  const cleaned = name
    .replaceAll(/[<>:"/\\|?*\u0000-\u001f]/gu, " ")
    .replaceAll(/\s+/gu, " ")
    .trim()
    .replaceAll(/[. ]+$/gu, "")
    .slice(0, 80)
    .trim();
  if (!cleaned || /^(con|prn|aux|nul|com\d|lpt\d)$/iu.test(cleaned))
    return "Untitled";
  return cleaned;
}

export type ProjectFolder = "Video" | "Shorts" | "Publish" | "Thumbnails";

/**
 * Everything made for a project lives together: Videos\Urushi\<project>\
 * with Video, Shorts, Publish and Thumbnails inside.
 */
export function organizedFolder(
  videos: string,
  project: string,
  kind: ProjectFolder,
): string {
  // A project named after its file ("Trailer.mp4") gets the folder "Trailer".
  const name = project.replace(/\.(mp4|mkv|mov|webm|avi|m4v)$/iu, "");
  return path.join(videos, "Urushi", safeFolderName(name), kind);
}

export interface PublishContext {
  /** The project's name (the folder name). */
  projectName: string;
  /** What the text is about: the project's name, or the clip's title. */
  name: string;
  durationUs: number;
  /** Spoken words timed from 0 at the start of the video or clip. */
  words: CaptionWord[];
}

export interface PublisherOptions {
  /** Where drafts are kept between sessions (inside the app's data). */
  root: string;
  /** The user's Videos folder. */
  videos(): string;
  context(request: PublishRequest): Promise<PublishContext>;
  /** Words the text with a connected model; null when none is available. */
  write?(prompt: string): Promise<string | null>;
  now(): string;
  /** Puts text on the clipboard. */
  copy(text: string): void;
  /** Opens a web page in the user's browser. */
  openPage(url: string): Promise<void>;
  /** Shows a file or folder in the system file manager. */
  reveal(path: string): void;
}

const toneWords: Record<PublishTone, string> = {
  casual: "relaxed and friendly, first person, no hype",
  professional: "clear and professional, no slang, no exclamation marks",
  funny: "light and a little funny, never at the viewer's expense",
};

/** The prompt that asks a model to word the text; timestamps are given, never asked for. */
export function writerPrompt(
  kit: PublishKit,
  sections: readonly TranscriptSection[],
  transcript: string,
): string {
  const kind =
    kit.subject.kind === "video" ? "a YouTube video" : "a YouTube Short";
  const sectionLines = sections
    .map(
      (section, index) =>
        `${index + 1}. [${Math.floor(section.startUs / 1_000_000)}s] ${section.text.slice(0, 260)}`,
    )
    .join("\n");
  return [
    `You write the publishing text for ${kind}. Tone: ${toneWords[kit.tone]}.`,
    `Video name: ${kit.subject.name}`,
    `Length: ${Math.round(kit.subject.durationUs / 1_000_000)} seconds`,
    "Transcript (start):",
    transcript.slice(0, 2400),
    sections.length > 0
      ? `Sections of the talk, in order (one chapter title each):\n${sectionLines}`
      : "There are no sections.",
    "",
    "Reply with ONLY one JSON object with these keys:",
    `"titles": 4 title ideas, best first, each at most ${publishLimits.title} characters, no clickbait lies;`,
    `"intro": the description above any chapters: 2 to 4 sentences, plain text, no hashtags;`,
    `"chapterTitles": exactly ${sections.length} short titles (at most 6 words) in section order${sections.length === 0 ? " (an empty list)" : ""};`,
    `"tags": up to 12 YouTube tags, each at most ${publishLimits.tag} characters;`,
    `"x": an X post of at most ${publishLimits.x} characters;`,
    `"redditTitle": a Reddit post title; "redditBody": a Reddit post body of a few short paragraphs;`,
    `"linkedin": a LinkedIn post; "discord": a Discord announcement.`,
    "Only use facts that are in the transcript. Do not invent timestamps.",
  ].join("\n");
}

function markdown(kit: PublishKit): string {
  const lines = [
    `# ${kit.youtube.title}`,
    "",
    "## Title ideas",
    ...(kit.youtube.titleIdeas.length > 0
      ? kit.youtube.titleIdeas.map((title) => `- ${title}`)
      : ["- (none)"]),
    "",
    "## Description",
    "",
    youtubeDescription(kit),
    "",
    "## Tags",
    "",
    kit.youtube.tags.join(", ") || "(none)",
    "",
    "## Posts",
    "",
    "### X",
    "",
    kit.posts.x,
    "",
    "### Reddit",
    "",
    `**${kit.posts.redditTitle}**`,
    "",
    kit.posts.redditBody,
    "",
    "### LinkedIn",
    "",
    kit.posts.linkedin,
    "",
    "### Discord",
    "",
    kit.posts.discord,
    "",
  ];
  if (kit.youtube.chapters.length > 0)
    lines.push("## Chapters", "", ...chapterLines(kit.youtube.chapters), "");
  return lines.join("\n");
}

export class Publisher {
  private readonly options: PublisherOptions;

  constructor(options: PublisherOptions) {
    this.options = options;
  }

  private file(request: PublishRequest): string {
    const key =
      request.kind === "video"
        ? "video"
        : `short-${createHash("sha256").update(request.subject_id).digest("hex").slice(0, 16)}`;
    return path.join(this.options.root, request.project_id, `${key}.json`);
  }

  private async read(request: PublishRequest): Promise<PublishKit | null> {
    try {
      const value: unknown = JSON.parse(
        await readFile(this.file(request), "utf8"),
      );
      assertPublishKit(value);
      return value;
    } catch {
      return null;
    }
  }

  private async store(request: PublishRequest, kit: PublishKit): Promise<void> {
    const target = this.file(request);
    await mkdir(path.dirname(target), { recursive: true });
    const staged = `${target}.tmp`;
    await writeFile(staged, `${JSON.stringify(kit)}\n`, "utf8");
    await rename(staged, target);
  }

  /** The folder and files for the kit; written whenever the text changes. */
  private async saveFiles(
    request: PublishRequest,
    kit: PublishKit,
    projectName: string,
  ): Promise<string> {
    const folder = path.join(
      organizedFolder(this.options.videos(), projectName, "Publish"),
      ...(request.kind === "short" ? ["Shorts"] : []),
    );
    await mkdir(folder, { recursive: true });
    const stem =
      request.kind === "video" ? "youtube" : safeFolderName(kit.subject.name);
    await writeFile(path.join(folder, `${stem}.md`), markdown(kit), "utf8");
    await writeFile(
      path.join(folder, `${stem}.json`),
      `${JSON.stringify(kit, null, 2)}\n`,
      "utf8",
    );
    return folder;
  }

  async view(request: PublishRequest): Promise<PublishView> {
    const kit = await this.read(request);
    if (!kit) return { kit: null, folder: null, message: null };
    const context = await this.options.context(request);
    return {
      kit,
      folder: path.join(
        organizedFolder(this.options.videos(), context.projectName, "Publish"),
        ...(request.kind === "short" ? ["Shorts"] : []),
      ),
      message: null,
    };
  }

  /** Writes the text: with a connected model when there is one, plainly otherwise. */
  async draft(request: PublishRequest): Promise<PublishView> {
    const context = await this.options.context(request);
    const previous = await this.read(request);
    const tone: PublishTone =
      request.tone ?? previous?.tone ?? publishTones[0]!;
    const base = draftKit({
      kind: request.kind,
      id: request.subject_id,
      name: context.name,
      durationUs: context.durationUs,
      tone,
      words: context.words,
      now: this.options.now(),
    });
    const sections =
      request.kind === "video"
        ? transcriptSections(context.words, context.durationUs)
        : [];
    let kit = base;
    let message =
      "Written from your transcript. Connect Claude or an API provider in Settings for better wording.";
    if (this.options.write) {
      const reply = await this.options
        .write(
          writerPrompt(
            base,
            sections,
            context.words.map((word) => word.text).join(" "),
          ),
        )
        .catch(() => null);
      const written = reply ? parseWrittenText(reply) : null;
      if (written) {
        kit = applyWrittenText(base, written, sections);
        message = "Written for you. Check it, then copy or upload.";
      } else if (reply !== null) {
        message =
          "The model's answer could not be used, so this is the plain version.";
      }
    }
    assertPublishKit(kit);
    await this.store(request, kit);
    const folder = await this.saveFiles(request, kit, context.projectName);
    return { kit, folder, message };
  }

  /** Keeps the person's edits and rewrites the saved files. */
  async save(request: PublishRequest, kit: PublishKit): Promise<PublishView> {
    assertPublishKit(kit);
    if (
      kit.subject.kind !== request.kind ||
      kit.subject.id !== request.subject_id
    )
      throw new Error("This text belongs to something else.");
    const context = await this.options.context(request);
    const next: PublishKit = { ...kit, updatedAt: this.options.now() };
    await this.store(request, next);
    const folder = await this.saveFiles(request, next, context.projectName);
    return { kit: next, folder, message: "Saved." };
  }

  /**
   * Saves a composed thumbnail (a JPEG, at most 2 MB) in the project's
   * Thumbnails folder; the person uploads it with the video.
   */
  async saveThumbnail(
    request: PublishRequest,
    jpeg: Uint8Array,
  ): Promise<PublishView> {
    const isJpeg =
      jpeg.length > 4 &&
      jpeg[0] === 0xff &&
      jpeg[1] === 0xd8 &&
      jpeg[2] === 0xff;
    if (!isJpeg || jpeg.length > thumbnailLimits.bytes)
      throw new Error("The thumbnail must be a JPEG under 2 MB.");
    if (request.kind !== "video")
      throw new Error("Only a video has a thumbnail.");
    const context = await this.options.context(request);
    const folder = organizedFolder(
      this.options.videos(),
      context.projectName,
      "Thumbnails",
    );
    await mkdir(folder, { recursive: true });
    const target = path.join(folder, "thumbnail.jpg");
    const staged = `${target}.tmp`;
    await writeFile(staged, jpeg);
    await rename(staged, target);
    const view = await this.view(request);
    return {
      ...view,
      folder,
      message: `Thumbnail saved: ${path.join(folder, "thumbnail.jpg")}`,
    };
  }

  /** Shows the folder the text and files are saved in. */
  async showFolder(request: PublishRequest): Promise<PublishView> {
    const view = await this.view(request);
    if (!view.kit || !view.folder)
      return { ...view, message: "Write the text first." };
    this.options.reveal(view.folder);
    return view;
  }

  /**
   * Quick upload without any account set-up: the title and description go on
   * the clipboard, YouTube's upload page opens, and the folder with the video
   * and thumbnail is shown.
   */
  async openStudio(request: PublishRequest): Promise<PublishView> {
    const view = await this.view(request);
    if (!view.kit || !view.folder)
      return { ...view, message: "Write the text first." };
    this.options.copy(
      `${view.kit.youtube.title}\n\n${youtubeDescription(view.kit)}`,
    );
    this.options.reveal(view.folder);
    await this.options.openPage("https://www.youtube.com/upload");
    return {
      ...view,
      message:
        "Title and description are copied. Choose your video on the YouTube page and paste them.",
    };
  }
}
