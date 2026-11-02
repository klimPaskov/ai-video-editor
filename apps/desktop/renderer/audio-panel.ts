import {
  defaultAudioSettings,
  type AudioSettings,
} from "../../../packages/domain/src/audio-settings.ts";

function element<T extends HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error("Missing control");
  return value as T;
}

/**
 * Audio card (Magic Edit step): export cleanup choices. They are part of the draft,
 * so the card re-reads them whenever the draft head changes (Undo, Redo or
 * an assistant edit).
 */
export function setupAudioPanel(): {
  render(projectId: string | undefined, draftSequence?: number): void;
} {
  const normalize = element<HTMLInputElement>("audio-normalize");
  const denoise = element<HTMLInputElement>("audio-denoise");
  let projectId: string | undefined;
  let settings: AudioSettings = { ...defaultAudioSettings };
  let attempt = 0;
  let sequence: number | undefined;

  function controls(): void {
    normalize.checked = settings.normalize;
    denoise.checked = settings.denoise;
  }

  async function save(): Promise<void> {
    const id = projectId;
    if (!id) return;
    const previous = settings;
    settings = { normalize: normalize.checked, denoise: denoise.checked };
    const current = ++attempt;
    const reply = await window.desktop
      .setAudioSettings({ schema_version: "1.0", project_id: id, settings })
      .catch(() => null);
    if (current !== attempt || id !== projectId) return;
    if (!reply?.ok) {
      settings = previous;
      controls();
    }
  }
  normalize.addEventListener("change", () => void save());
  denoise.addEventListener("change", () => void save());

  function load(id: string): void {
    const current = attempt;
    void window.desktop
      .getAudioSettings({ schema_version: "1.0", project_id: id })
      .then((reply) => {
        // A newer save owns the controls; its reply decides them.
        if (projectId !== id || current !== attempt || !reply.ok) return;
        settings = reply.value;
        controls();
      })
      .catch(() => undefined);
  }

  return {
    render(id, draftSequence) {
      if (id === projectId) {
        if (id && draftSequence !== sequence) {
          sequence = draftSequence;
          load(id);
        }
        return;
      }
      projectId = id;
      sequence = draftSequence;
      settings = { ...defaultAudioSettings };
      controls();
      if (id) load(id);
    },
  };
}
