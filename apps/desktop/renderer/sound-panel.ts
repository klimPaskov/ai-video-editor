import type {
  SoundLayerView,
  SoundsView,
} from "../../../packages/domain/src/sound-view.ts";
import { soundLimits } from "../../../packages/domain/src/sounds.ts";

function element<T extends HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error("Missing control");
  return value as T;
}

function clock(us: number): string {
  const seconds = Math.floor(us / 1_000_000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * Sound card (Magic Edit step): music and sound effects mixed into the edit. Layers are
 * part of the draft, so the card re-reads them whenever the draft head changes
 * (Undo, Redo or an assistant edit). Adding opens a file dialog in the main
 * process; no file path reaches this page.
 */
export function setupSoundPanel(options: {
  /** The playhead, in output microseconds, where an effect is placed. */
  position(): number;
  /** The layers changed (loaded, edited or reset). */
  changed(layers: readonly SoundLayerView[]): void;
}): {
  render(projectId: string | undefined, draftSequence?: number): void;
} {
  const list = element<HTMLElement>("sound-list");
  const note = element<HTMLElement>("sound-note");
  const addMusic = element<HTMLButtonElement>("sound-add-music");
  const addEffect = element<HTMLButtonElement>("sound-add-effect");
  let projectId: string | undefined;
  let sequence: number | undefined;
  let attempt = 0;
  let loads = 0;
  let busy = false;

  function show(message: string): void {
    note.textContent = message;
    note.hidden = message === "";
  }

  function setBusy(value: boolean): void {
    busy = value;
    addMusic.disabled = value || projectId === undefined;
    addEffect.disabled = value || projectId === undefined;
    for (const control of list.querySelectorAll<HTMLElement>("input, button"))
      (control as HTMLInputElement).disabled = value;
  }

  function row(layer: SoundLayerView): HTMLElement {
    const item = document.createElement("div");
    item.className = "sound-row";
    const title = document.createElement("span");
    title.className = "sound-title";
    title.textContent = layer.name;
    title.title = layer.file_name;
    const where = document.createElement("span");
    where.className = "muted sound-where";
    where.textContent = layer.timeline_range
      ? `${layer.kind === "music" ? "Music" : "Effect"} ${clock(layer.timeline_range.start_us)}–${clock(layer.timeline_range.end_us)}`
      : "Cut away, not heard";
    const volume = document.createElement("input");
    volume.type = "range";
    volume.min = String(soundLimits.minGainDb);
    volume.max = "0";
    volume.step = "1";
    volume.value = String(Math.min(0, layer.gain_db));
    volume.setAttribute("aria-label", `Volume of ${layer.name}`);
    const level = document.createElement("span");
    level.className = "muted sound-level";
    level.textContent = `${layer.gain_db} dB`;
    volume.addEventListener("input", () => {
      level.textContent = `${volume.value} dB`;
    });
    const duck = document.createElement("label");
    duck.className = "switch";
    const duckBox = document.createElement("input");
    duckBox.type = "checkbox";
    duckBox.checked = layer.duck_db > 0;
    duck.append(duckBox, "Lower under speech");
    const save = () =>
      void run(
        window.desktop.updateSound({
          schema_version: "1.0",
          project_id: projectId!,
          sound_id: layer.sound_id,
          gain_db: Number(volume.value),
          duck_db: duckBox.checked ? Math.max(layer.duck_db, 12) : 0,
        }),
      );
    volume.addEventListener("change", save);
    duckBox.addEventListener("change", save);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "ghost";
    remove.textContent = "Remove";
    remove.setAttribute("aria-label", `Remove ${layer.name}`);
    remove.addEventListener(
      "click",
      () =>
        void run(
          window.desktop.removeSound({
            schema_version: "1.0",
            project_id: projectId!,
            sound_id: layer.sound_id,
          }),
        ),
    );
    item.append(title, where, volume, level, duck, remove);
    return item;
  }

  function draw(view: SoundsView): void {
    list.replaceChildren(...view.layers.map(row));
    list.hidden = view.layers.length === 0;
    options.changed(view.layers);
  }

  async function run(
    work: Promise<
      { ok: true; value: SoundsView } | { ok: false; message: string }
    >,
  ): Promise<void> {
    const id = projectId;
    if (!id || busy) return;
    const current = ++attempt;
    setBusy(true);
    show("");
    try {
      const reply = await work.catch(() => null);
      if (current !== attempt || id !== projectId) return;
      if (reply?.ok) draw(reply.value);
      else show(reply?.message ?? "Sound could not be changed.");
    } finally {
      if (current === attempt) setBusy(false);
    }
  }

  function add(kind: "music" | "effect"): void {
    const id = projectId;
    if (!id) return;
    void run(
      window.desktop.addSound({
        schema_version: "1.0",
        project_id: id,
        kind,
        start_us: kind === "music" ? 0 : Math.max(0, options.position()),
      }),
    );
  }
  addMusic.addEventListener("click", () => add("music"));
  addEffect.addEventListener("click", () => add("effect"));

  function load(id: string): void {
    const current = ++loads;
    void window.desktop
      .getSounds({ schema_version: "1.0", project_id: id })
      .then((reply) => {
        if (projectId !== id || current !== loads || !reply.ok) return;
        draw(reply.value);
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
      attempt++;
      loads++;
      list.replaceChildren();
      list.hidden = true;
      options.changed([]);
      show("");
      setBusy(false);
      if (id) load(id);
    },
  };
}
