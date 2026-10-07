import {
  buildCaptionCues,
  captionSourceWords,
  captionWordsForDraft,
  cueAt,
  defaultCaptionSettings,
  type CaptionCue,
  type CaptionSettings,
} from "../../../packages/domain/src/captions.ts";
import type { ProjectView } from "../../../packages/domain/src/project-view.ts";
import type { TranscriptionProjectView } from "../../../packages/domain/src/transcription.ts";

function element<T extends HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error("Missing control");
  return value as T;
}

/**
 * Captions card (Auto Edit) and the caption overlay on the preview. Cues
 * are derived from the transcript, its text corrections and the current
 * clip map, so they follow every edit; only the style is stored.
 */
export function setupCaptions(options: { preview: HTMLElement }): {
  render(
    project: ProjectView | undefined,
    transcription: TranscriptionProjectView | undefined,
    positionUs: number,
  ): void;
  position(positionUs: number): void;
} {
  const overlay = document.createElement("div");
  overlay.id = "caption-overlay";
  overlay.className = "caption-overlay";
  overlay.setAttribute("aria-hidden", "true");
  overlay.hidden = true;
  options.preview.append(overlay);
  const enabled = element<HTMLInputElement>("captions-enabled");
  const style = element<HTMLSelectElement>("captions-style");
  const size = element<HTMLSelectElement>("captions-size");
  const placement = element<HTMLSelectElement>("captions-position");
  const note = element("captions-note");
  let projectId: string | undefined;
  let settings: CaptionSettings = { ...defaultCaptionSettings };
  let cues: CaptionCue[] = [];
  let key = "";
  let fetched: TranscriptionProjectView | undefined;
  let lastPosition = 0;
  let saving = 0;

  function controls(): void {
    enabled.checked = settings.enabled;
    style.value = settings.style;
    size.value = settings.size;
    placement.value = settings.position;
    for (const control of [style, size, placement])
      control.disabled = !settings.enabled;
  }

  async function load(id: string): Promise<void> {
    settings = { ...defaultCaptionSettings };
    controls();
    const [stored, transcript] = await Promise.all([
      window.desktop
        .getCaptionSettings({ schema_version: "1.0", project_id: id })
        .catch(() => null),
      window.desktop
        .getTranscription({
          schema_version: "1.0",
          project_id: id,
          job_id: null,
        })
        .catch(() => null),
    ]);
    if (projectId !== id) return;
    if (stored?.ok) settings = stored.value;
    if (transcript?.ok) fetched = transcript.value;
    key = "";
    controls();
    position(lastPosition);
  }

  async function save(): Promise<void> {
    const id = projectId;
    if (!id) return;
    const next: CaptionSettings = {
      enabled: enabled.checked,
      style: style.value as CaptionSettings["style"],
      size: size.value as CaptionSettings["size"],
      position: placement.value as CaptionSettings["position"],
    };
    const attempt = ++saving;
    const previous = settings;
    settings = next;
    controls();
    position(lastPosition);
    const reply = await window.desktop
      .setCaptionSettings({
        schema_version: "1.0",
        project_id: id,
        settings: next,
      })
      .catch(() => null);
    if (attempt !== saving || projectId !== id) return;
    if (!reply?.ok) {
      settings = previous;
      controls();
      position(lastPosition);
    }
  }
  for (const control of [enabled, style, size, placement])
    control.addEventListener("change", () => void save());

  /** The displayed media rectangle inside the preview (object-fit: contain). */
  function mediaBox(): {
    left: number;
    top: number;
    width: number;
    height: number;
  } {
    const box = options.preview.getBoundingClientRect();
    const visible =
      options.preview.querySelector<HTMLVideoElement>("video:not([hidden])") ??
      options.preview.querySelector<HTMLCanvasElement>("canvas");
    const intrinsicWidth =
      visible instanceof HTMLVideoElement
        ? visible.videoWidth
        : (visible?.width ?? 0);
    const intrinsicHeight =
      visible instanceof HTMLVideoElement
        ? visible.videoHeight
        : (visible?.height ?? 0);
    if (!intrinsicWidth || !intrinsicHeight)
      return { left: 0, top: 0, width: box.width, height: box.height };
    const scale = Math.min(
      box.width / intrinsicWidth,
      box.height / intrinsicHeight,
    );
    const width = intrinsicWidth * scale,
      height = intrinsicHeight * scale;
    return {
      left: (box.width - width) / 2,
      top: (box.height - height) / 2,
      width,
      height,
    };
  }

  function position(positionUs: number): void {
    lastPosition = positionUs;
    const cue = settings.enabled ? cueAt(cues, positionUs) : undefined;
    overlay.hidden = !cue;
    if (!cue) return;
    const media = mediaBox();
    overlay.style.left = `${media.left}px`;
    overlay.style.top = `${media.top}px`;
    overlay.style.width = `${media.width}px`;
    overlay.style.height = `${media.height}px`;
    overlay.dataset.style = settings.style;
    overlay.dataset.size = settings.size;
    overlay.dataset.position = settings.position;
    overlay.style.setProperty("--caption-scale", `${media.height / 100}px`);
    const block = document.createElement("div");
    block.className = "caption-block";
    // Lines are rebuilt from words so the spoken word can be highlighted.
    let wordIndex = 0;
    for (const [lineIndex, text] of cue.lines.entries()) {
      const line = document.createElement("div");
      line.className = "caption-line";
      const count = cue.lineWordCounts[lineIndex] ?? 0;
      const words = cue.words.slice(wordIndex, wordIndex + count);
      wordIndex += count;
      if (settings.style === "highlight") {
        for (const [index, word] of words.entries()) {
          if (index > 0 && !/^[,.;:!?…%)}\]»”’]+$/u.test(word.text))
            line.append(" ");
          const span = document.createElement("span");
          span.textContent = word.text;
          if (positionUs >= word.startUs && positionUs < word.endUs)
            span.className = "spoken";
          line.append(span);
        }
      } else line.textContent = text;
      block.append(line);
    }
    overlay.replaceChildren(block);
  }

  return {
    render(project, transcription, positionUs) {
      if (project?.id !== projectId) {
        projectId = project?.id;
        fetched = undefined;
        cues = [];
        key = "";
        overlay.hidden = true;
        if (projectId) void load(projectId);
      }
      if (!project) return;
      const view =
        transcription && transcription.project_id === project.id
          ? transcription
          : fetched;
      const results = view?.results ?? [];
      const nextKey = `${project.draft.sequence}:${project.draft.timelineSha256}:${results
        .map((result) => result.transcript.transcript_id)
        .join(",")}:${JSON.stringify(project.transcriptEdits ?? [])}`;
      if (nextKey !== key) {
        key = nextKey;
        cues = buildCaptionCues(
          captionWordsForDraft(
            captionSourceWords(results, project.transcriptEdits ?? []),
            project.clips ?? [],
          ),
        );
      }
      note.textContent =
        results.length === 0
          ? "Captions use the transcript. Transcribe first."
          : cues.length === 0
            ? "No spoken words remain in this draft."
            : `${cues.length} ${cues.length === 1 ? "caption" : "captions"} · exported as an .srt file beside the video`;
      enabled.disabled = results.length === 0;
      position(positionUs);
    },
    position,
  };
}
