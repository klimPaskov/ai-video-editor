import { fillPlatformLogos } from "./platform-logos.ts";
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
}

type Reply = { ok: true; value: PublishView } | { ok: false; message: string };

/**
 * The publishing text of a finished video or one short clip: YouTube title,
 * description with chapters, tags and posts for X, Reddit, LinkedIn and
 * Discord. Edits are saved as they are made; every button acts on the same
 * main-process publisher that writes the files into the project's Publish
 * folder.
 */
export function setupPublishDialog(): { open(subject: PublishSubject): void } {
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
  const tags = element<HTMLInputElement>("publish-tags");
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
    tags.value = kit.youtube.tags.join(", ");
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
            if (!kit) return;
            kit = { ...kit, youtube: { ...kit.youtube, title: idea } };
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

  /** The X counter turns to a warning near the limit. */
  function countX(): void {
    const used = postX.value.length;
    postXCount.textContent = `${used}/${publishLimits.x}`;
    postXCount.classList.toggle("near-limit", used >= publishLimits.x - 20);
  }

  function readFields(): PublishKit | null {
    if (!kit) return null;
    return {
      ...kit,
      youtube: {
        ...kit.youtube,
        title: titleInput.value.trim() || kit.youtube.title,
        intro: intro.value,
        tags: cleanTags(tags.value.split(",")),
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
    tab.addEventListener("click", () => {
      showTab(tab.dataset.tab ?? "youtube");
      draw();
    });

  for (const field of [titleInput, intro, tags, redditTitle, redditBody])
    field.addEventListener("input", queueSave);
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
