import { fillPlatformLogos } from "./platform-logos.ts";
import { composeThumbnail, jpegBase64 } from "./thumbnail.ts";
import {
  cleanTags,
  formatTimestamp,
  publishLimits,
  youtubeDescription,
  type PublishKit,
  type PublishRequest,
  type PublishTone,
  type PublishView,
} from "../../../packages/domain/src/publish.ts";

function element<T extends HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error("Missing control");
  return value as T;
}

export interface PublishSubject {
  projectId: string;
  kind: "video" | "short";
  /** The project's id for a video, the clip's id for a short. */
  subjectId: string;
  /** What the text is about, shown under the title. */
  name: string;
  /** The control that opened the dialog, focused again when it closes. */
  opener?: HTMLElement | undefined;
  /** The time in the video whose picture is shown as the thumbnail. */
  pictureAtUs: number;
}

type Reply = { ok: true; value: PublishView } | { ok: false; message: string };

/**
 * The publishing text of a finished video or one short clip: YouTube title,
 * description with chapters, tags and posts for X, Reddit, LinkedIn and
 * Discord. Edits are saved as they are made; every button acts on the same
 * main-process publisher that writes the files into the project's Publish
 * folder.
 */
export function setupPublishDialog(options: {
  /** A picture of the footage at this time, or null. */
  picture(timeUs: number): Promise<HTMLCanvasElement | null>;
}): { open(subject: PublishSubject): void } {
  const dialog = element<HTMLDialogElement>("publish-dialog");
  const heading = element("publish-title");
  const subjectText = element("publish-subject");
  const tabs = [...dialog.querySelectorAll<HTMLButtonElement>("[data-tab]")];
  const youtubePane = element("publish-youtube");
  const postsPane = element("publish-posts");
  const empty = element("publish-empty");
  const titleInput = element<HTMLInputElement>("publish-title-input");
  const ideas = element("publish-ideas");
  const intro = element<HTMLTextAreaElement>("publish-intro");
  const chaptersBox = element("publish-chapters-box");
  const chapters = element("publish-chapters");
  const titleCount = element("publish-title-count");
  const tagChips = element("publish-tag-chips");
  const tagInput = element<HTMLInputElement>("publish-tag-input");
  const tagEditor = element("publish-tag-editor");
  const thumb = element("publish-thumb");
  const thumbPicture = element("publish-thumb-picture");
  const thumbTitle = element("publish-thumb-title");
  const thumbTime = element("publish-thumb-time");
  const thumbSave = element<HTMLButtonElement>("publish-thumb-save");
  const xRing = element("publish-x-ring");
  const postX = element<HTMLTextAreaElement>("publish-x");
  const postXCount = element("publish-x-count");
  const redditTitle = element<HTMLInputElement>("publish-reddit-title");
  const redditBody = element<HTMLTextAreaElement>("publish-reddit-body");
  const linkedin = element<HTMLTextAreaElement>("publish-linkedin");
  const discord = element<HTMLTextAreaElement>("publish-discord");
  const message = element("publish-message");
  const folderText = element("publish-folder");
  const tone = element<HTMLSelectElement>("publish-tone");
  const again = element<HTMLButtonElement>("publish-again");
  const copyAll = element<HTMLButtonElement>("publish-copy");
  const openFolder = element<HTMLButtonElement>("publish-folder-open");
  const upload = element<HTMLButtonElement>("publish-upload");
  const errorText = element("publish-error");

  fillPlatformLogos(dialog);
  let subject: PublishSubject | undefined;
  let kit: PublishKit | null = null;
  let busy = false;
  /** The tags as chips; the kit takes them when the text is read. */
  let tagList: string[] = [];
  /** The footage picture for the current subject, drawn once. */
  let picture: HTMLCanvasElement | null = null;
  let saveTimer: number | undefined;
  let generation = 0;

  const request = (): PublishRequest => ({
    schema_version: "1.0",
    project_id: subject!.projectId,
    kind: subject!.kind,
    subject_id: subject!.subjectId,
  });

  function say(text: string | null): void {
    message.textContent = text ?? "";
    message.hidden = !text;
  }

  function fail(text: string | null): void {
    errorText.textContent = text ?? "";
    errorText.hidden = !text;
  }

  function showTab(name: string): void {
    for (const tab of tabs)
      tab.setAttribute("aria-pressed", String(tab.dataset.tab === name));
    youtubePane.hidden = name !== "youtube" || !kit;
    postsPane.hidden = name !== "posts" || !kit;
  }

  function currentTab(): string {
    return (
      tabs.find((tab) => tab.getAttribute("aria-pressed") === "true")?.dataset
        .tab ?? "youtube"
    );
  }

  function draw(): void {
    const has = kit !== null;
    empty.hidden = has;
    showTab(currentTab());
    for (const control of [copyAll, openFolder, upload, tone])
      control.disabled = busy || !has;
    again.disabled = busy;
    again.textContent = has ? "Write again" : "Write the text";
    if (!kit) return;
    tone.value = kit.tone;
    titleInput.value = kit.youtube.title;
    intro.value = kit.youtube.intro;
    tagList = [...kit.youtube.tags];
    drawTags();
    countTitle();
    drawThumb();
    postX.value = kit.posts.x;
    countX();
    redditTitle.value = kit.posts.redditTitle;
    redditBody.value = kit.posts.redditBody;
    linkedin.value = kit.posts.linkedin;
    discord.value = kit.posts.discord;
    ideas.replaceChildren(
      ...kit.youtube.titleIdeas
        .filter((idea) => idea !== kit!.youtube.title)
        .map((idea) => {
          const chip = document.createElement("button");
          chip.type = "button";
          chip.className = "chip";
          chip.textContent = idea;
          chip.setAttribute("aria-label", `Use the title: ${idea}`);
          chip.addEventListener("click", () => {
            const current = readFields();
            if (!current) return;
            kit = { ...current, youtube: { ...current.youtube, title: idea } };
            draw();
            queueSave();
          });
          return chip;
        }),
    );
    chaptersBox.hidden = kit.youtube.chapters.length === 0;
    chapters.replaceChildren(
      ...kit.youtube.chapters.map((chapter, index) => {
        const item = document.createElement("li");
        const time = document.createElement("span");
        time.className = "chapter-time";
        time.textContent = formatTimestamp(chapter.startUs);
        const name = document.createElement("input");
        name.type = "text";
        name.value = chapter.title;
        name.maxLength = 80;
        name.setAttribute("aria-label", `Chapter ${index + 1} title`);
        name.addEventListener("input", () => {
          if (!kit) return;
          const next = kit.youtube.chapters.map((entry, at) =>
            at === index ? { ...entry, title: name.value } : entry,
          );
          kit = { ...kit, youtube: { ...kit.youtube, chapters: next } };
          queueSave();
        });
        item.append(time, name);
        return item;
      }),
    );
  }

  /** The X counter fills a ring and turns to a warning near the limit. */
  function countX(): void {
    const used = postX.value.length;
    postXCount.textContent = `${used}/${publishLimits.x}`;
    const near = used >= publishLimits.x - 20;
    postXCount.classList.toggle("near-limit", near);
    xRing.classList.toggle("near-limit", near);
    xRing.style.setProperty(
      "--used",
      String(Math.min(100, Math.round((used / publishLimits.x) * 100))),
    );
  }

  function countTitle(): void {
    titleCount.textContent = `${titleInput.value.length} / ${publishLimits.title}`;
    thumbTitle.textContent = titleInput.value;
  }

  /** The tags as removable chips in front of the field that adds one. */
  function drawTags(): void {
    tagChips.replaceChildren(
      ...tagList.map((tag) => {
        const chip = document.createElement("span");
        chip.className = "tag-chip";
        const text = document.createElement("span");
        text.textContent = tag;
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "tag-remove";
        remove.dataset.icon = "close";
        remove.setAttribute("aria-label", `Remove the tag ${tag}`);
        remove.addEventListener("click", () => {
          tagList = tagList.filter((entry) => entry !== tag);
          drawTags();
          queueSave();
        });
        chip.append(text, remove);
        return chip;
      }),
    );
  }

  /** Adds what is typed as tags (several at once with commas). */
  function addTags(text: string): void {
    const next = cleanTags([...tagList, ...text.split(",")]);
    if (next.length === tagList.length) {
      tagInput.value = "";
      return;
    }
    tagList = next;
    tagInput.value = "";
    drawTags();
    queueSave();
  }

  /** The footage picture with the title and length over it, as on YouTube. */
  function drawThumb(): void {
    const show = picture !== null && kit !== null;
    thumb.hidden = !show;
    thumbPicture.replaceChildren(...(picture ? [picture] : []));
    thumbTime.textContent = kit ? formatTimestamp(kit.subject.durationUs) : "";
    thumbTitle.textContent = titleInput.value;
    // Only a video has a thumbnail to upload; a short shows the picture only.
    thumbSave.hidden = kit?.subject.kind !== "video";
    thumbSave.disabled = busy;
  }

  function readFields(): PublishKit | null {
    if (!kit) return null;
    return {
      ...kit,
      youtube: {
        ...kit.youtube,
        title: titleInput.value.trim() || kit.youtube.title,
        intro: intro.value,
        tags: cleanTags([...tagList, ...tagInput.value.split(",")]),
      },
      posts: {
        x: postX.value,
        redditTitle: redditTitle.value,
        redditBody: redditBody.value,
        linkedin: linkedin.value,
        discord: discord.value,
      },
    };
  }

  function apply(reply: Reply | null, fallback: string): boolean {
    if (!reply?.ok) {
      fail(reply && !reply.ok ? reply.message : fallback);
      return false;
    }
    kit = reply.value.kit;
    folderText.textContent = reply.value.folder
      ? `Saved to ${reply.value.folder}`
      : "";
    folderText.hidden = !reply.value.folder;
    say(reply.value.message);
    return true;
  }

  async function save(): Promise<boolean> {
    window.clearTimeout(saveTimer);
    saveTimer = undefined;
    const next = readFields();
    if (!subject || !next) return true;
    const attempt = generation;
    const reply = await window.desktop
      .savePublish({ ...request(), kit: next })
      .catch(() => null);
    if (attempt !== generation) return false;
    if (!reply?.ok) {
      fail(
        reply && !reply.ok
          ? reply.message
          : "The text could not be saved. Check the lengths and try again.",
      );
      return false;
    }
    kit = reply.value.kit;
    fail(null);
    return true;
  }

  function queueSave(): void {
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => void save(), 600);
  }

  async function run(
    work: () => Promise<Reply>,
    fallback: string,
  ): Promise<void> {
    if (!subject || busy) return;
    const attempt = generation;
    busy = true;
    fail(null);
    draw();
    const reply = await work().catch(() => null);
    if (attempt !== generation) return;
    busy = false;
    apply(reply, fallback);
    draw();
  }

  async function load(): Promise<void> {
    await run(
      () => window.desktop.getPublish(request()),
      "The text could not be loaded.",
    );
    // First time here: write it straight away so there is something to read.
    if (subject && !kit && !busy && !errorText.textContent) await write();
  }

  async function write(): Promise<void> {
    if (!subject) return;
    say("Writing the text…");
    await run(
      () =>
        window.desktop.draftPublish({
          ...request(),
          tone: tone.value as PublishTone,
        }),
      "The text could not be written.",
    );
  }

  /** Puts text on the clipboard; the page may not be allowed to. */
  async function copy(text: string, done: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      say(done);
      fail(null);
    } catch {
      fail("Copying is not available here. Select the text and copy it.");
    }
  }

  for (const tab of tabs)
    // Only the pane changes: redrawing would replace unsaved typing.
    tab.addEventListener("click", () => showTab(tab.dataset.tab ?? "youtube"));

  for (const field of [titleInput, intro, redditTitle, redditBody])
    field.addEventListener("input", queueSave);
  titleInput.addEventListener("input", countTitle);
  tagEditor.addEventListener("click", () => tagInput.focus());
  tagInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      addTags(tagInput.value);
    } else if (
      event.key === "Backspace" &&
      tagInput.value === "" &&
      tagList.length > 0
    ) {
      tagList = tagList.slice(0, -1);
      drawTags();
      queueSave();
    }
  });
  tagInput.addEventListener("blur", () => {
    if (tagInput.value.trim()) addTags(tagInput.value);
  });
  for (const field of [postX, linkedin, discord])
    field.addEventListener("input", () => {
      countX();
      queueSave();
    });

  for (const button of dialog.querySelectorAll<HTMLButtonElement>(
    "[data-copy]",
  ))
    button.addEventListener("click", () => {
      const which = button.dataset.copy;
      const text =
        which === "x"
          ? postX.value
          : which === "reddit"
            ? `${redditTitle.value}\n\n${redditBody.value}`
            : which === "linkedin"
              ? linkedin.value
              : discord.value;
      void copy(text, "Copied.");
    });

  thumbSave.addEventListener("click", () => {
    void (async () => {
      if (!picture || !(await save())) return;
      const title = titleInput.value.trim() || kit?.youtube.title || "";
      let data: string;
      try {
        data = await jpegBase64(composeThumbnail(picture, title));
      } catch {
        fail("The thumbnail could not be made. Try again.");
        return;
      }
      await run(
        () =>
          window.desktop.savePublishThumbnail({
            ...request(),
            jpeg_base64: data,
          }),
        "The thumbnail could not be saved.",
      );
    })();
  });
  again.addEventListener("click", () => void write());
  copyAll.addEventListener("click", () => {
    void (async () => {
      if (!(await save()) || !kit) return;
      await copy(
        `${kit.youtube.title}\n\n${youtubeDescription(kit)}`,
        "Title and description copied.",
      );
    })();
  });
  openFolder.addEventListener("click", () => {
    void (async () => {
      if (!(await save())) return;
      await run(
        () => window.desktop.showPublishFolder(request()),
        "The folder could not be opened.",
      );
    })();
  });
  upload.addEventListener("click", () => {
    void (async () => {
      if (!(await save())) return;
      await run(
        () => window.desktop.openYoutube(request()),
        "YouTube could not be opened.",
      );
    })();
  });

  function close(): void {
    dialog.close();
  }
  element("publish-close").addEventListener("click", close);
  dialog.addEventListener("close", () => {
    // Keep what was typed before the window goes away.
    if (saveTimer !== undefined) void save();
    generation++;
    busy = false;
    const opener = subject?.opener;
    subject = undefined;
    if (opener?.isConnected) opener.focus();
  });

  return {
    open(next) {
      generation++;
      subject = next;
      kit = null;
      picture = null;
      tagList = [];
      tagInput.value = "";
      void options.picture(next.pictureAtUs).then((canvas) => {
        if (subject !== next) return;
        picture = canvas;
        drawThumb();
      });
      busy = false;
      heading.textContent =
        next.kind === "video" ? "Publish your video" : "Publish this short";
      subjectText.textContent = next.name;
      folderText.hidden = true;
      say(null);
      fail(null);
      showTab("youtube");
      draw();
      if (!dialog.open) dialog.showModal();
      void load();
    },
  };
}
