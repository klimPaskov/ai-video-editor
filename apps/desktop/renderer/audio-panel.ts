import {
  defaultAudioSettings,
  type AudioSettings,
} from "../../../packages/domain/src/audio-settings.ts";

function element<T extends HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error("Missing control");
  return value as T;
}

/** Audio card (Auto Edit): cleanup choices stored per project for exports. */
export function setupAudioPanel(): {
  render(projectId: string | undefined): void;
} {
  const normalize = element<HTMLInputElement>("audio-normalize");
  const denoise = element<HTMLInputElement>("audio-denoise");
  let projectId: string | undefined;
  let settings: AudioSettings = { ...defaultAudioSettings };
  let attempt = 0;

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

  return {
    render(id) {
      if (id === projectId) return;
      projectId = id;
      settings = { ...defaultAudioSettings };
      controls();
      if (!id) return;
      void window.desktop
        .getAudioSettings({ schema_version: "1.0", project_id: id })
        .then((reply) => {
          if (projectId !== id || !reply.ok) return;
          settings = reply.value;
          controls();
        })
        .catch(() => undefined);
    },
  };
}
