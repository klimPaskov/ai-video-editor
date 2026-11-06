import {
  acceleratorFromEvent,
  assertShortcutChoices,
  resolveShortcuts,
  shortcutActions,
  type ShortcutChoices,
  type ShortcutId,
} from "../../../packages/domain/src/shortcuts.ts";
import type { Preferences } from "../../../packages/domain/src/preferences.ts";

export interface ShortcutsSection {
  /** The section was opened: read the saved choices and the system's answer. */
  activate(): void;
  /** The accelerator in effect for every action. */
  map(): Record<ShortcutId, string | null>;
  /** Takes the saved choices (at start and after each change). */
  load(choices: ShortcutChoices | undefined): void;
}

const apple = /Mac|iPhone|iPad/u.test(navigator.platform);
const keyNames: Record<string, string> = {
  CommandOrControl: apple ? "⌘" : "Ctrl",
  Alt: apple ? "⌥" : "Alt",
  Shift: apple ? "⇧" : "Shift",
  Left: "←",
  Right: "→",
  Up: "↑",
  Down: "↓",
};

/** "CommandOrControl+Shift+F9" as a person reads it: "Ctrl+Shift+F9". */
export function showAccelerator(accelerator: string | null): string {
  if (accelerator === null) return "Off";
  return accelerator
    .split("+")
    .map((part) => keyNames[part] ?? part)
    .join("+");
}

export function setupShortcutsSettings(
  dialog: HTMLDialogElement,
): ShortcutsSection {
  const element = <T extends HTMLElement = HTMLElement>(id: string) =>
    document.getElementById(id)! as T;
  const list = element("shortcut-list");
  const message = element("shortcut-message");
  let choices: ShortcutChoices = {};
  let unavailable: ShortcutId[] = [];
  let capturing: ShortcutId | null = null;
  let saving = false;
  // Rebuilding the list removes the focused button, which blurs it; that
  // must not end a capture that is just starting.
  let rendering = false;

  const say = (text: string) => {
    message.textContent = text;
  };

  function render(): void {
    const resolved = resolveShortcuts(choices);
    rendering = true;
    list.replaceChildren(
      ...shortcutActions.map((action) => {
        const row = document.createElement("li");
        row.dataset.shortcut = action.id;
        const name = document.createElement("span");
        name.className = "shortcut-name";
        name.textContent = action.label;
        if (action.scope === "global") {
          const note = document.createElement("small");
          note.textContent = unavailable.includes(action.id)
            ? "Another program already uses this key, so it won't work from other programs"
            : "Works from any program";
          if (unavailable.includes(action.id)) note.className = "shortcut-bad";
          name.append(note);
        }
        const key = document.createElement("button");
        key.type = "button";
        key.className = "shortcut-key";
        key.dataset.shortcutKey = action.id;
        key.setAttribute(
          "aria-label",
          `Change the shortcut for ${action.label}`,
        );
        key.textContent =
          capturing === action.id
            ? "Press the keys…"
            : showAccelerator(resolved[action.id]);
        key.addEventListener("click", () => begin(action.id));
        key.addEventListener("keydown", (event) => keyDown(event, action.id));
        key.addEventListener("blur", () => {
          if (!rendering && capturing === action.id) {
            capturing = null;
            render();
          }
        });
        const off = document.createElement("button");
        off.type = "button";
        off.className = "ghost";
        off.textContent = "Off";
        off.setAttribute(
          "aria-label",
          `Turn off the shortcut for ${action.label}`,
        );
        off.disabled = resolved[action.id] === null;
        off.addEventListener("click", () => void change(action.id, null));
        const reset = document.createElement("button");
        reset.type = "button";
        reset.className = "ghost";
        reset.textContent = "Reset";
        reset.setAttribute(
          "aria-label",
          `Restore the default shortcut for ${action.label}`,
        );
        reset.disabled = resolved[action.id] === action.default;
        reset.addEventListener(
          "click",
          () => void change(action.id, action.default),
        );
        row.append(name, key, off, reset);
        return row;
      }),
    );
    rendering = false;
  }

  function begin(id: ShortcutId): void {
    capturing = id;
    say("Press the keys you want. Escape cancels.");
    render();
    list
      .querySelector<HTMLButtonElement>(`[data-shortcut-key="${id}"]`)
      ?.focus();
  }

  function keyDown(event: KeyboardEvent, id: ShortcutId): void {
    if (capturing !== id) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") {
      capturing = null;
      say("");
      render();
      list
        .querySelector<HTMLButtonElement>(`[data-shortcut-key="${id}"]`)
        ?.focus();
      return;
    }
    const accelerator = acceleratorFromEvent(event);
    // A lone modifier, or a key that cannot be used, waits for the next press.
    if (accelerator === null) {
      if (!["Control", "Shift", "Alt", "Meta"].includes(event.key))
        say("That key can't be used. Try another.");
      return;
    }
    void change(id, accelerator);
  }

  async function change(
    id: ShortcutId,
    accelerator: string | null,
  ): Promise<void> {
    if (saving) return;
    const action = shortcutActions.find((item) => item.id === id)!;
    const next: ShortcutChoices = { ...choices };
    if (accelerator === action.default) delete next[id];
    else next[id] = accelerator;
    try {
      assertShortcutChoices(next);
    } catch (error) {
      capturing = null;
      say(
        error instanceof Error ? error.message : "That shortcut can't be used.",
      );
      render();
      return;
    }
    saving = true;
    capturing = null;
    try {
      const current = await window.desktop.getPreferences();
      if (!current.ok) throw new Error("load");
      const value: Preferences = { ...current.value };
      if (Object.keys(next).length > 0) value.shortcuts = next;
      else delete value.shortcuts;
      const saved = await window.desktop.setPreferences(value);
      if (!saved.ok) throw new Error("save");
      choices = saved.value.shortcuts ?? {};
      const status = await window.desktop.getShortcutStatus();
      unavailable = status.ok ? status.value.unavailable : [];
      say(
        unavailable.includes(id)
          ? "Saved, but another program already uses that key, so it won't work from other programs."
          : "Shortcut saved.",
      );
    } catch {
      say("The shortcut could not be saved. Nothing changed. Try again.");
    } finally {
      saving = false;
      render();
    }
  }

  element("shortcuts-reset-all").addEventListener("click", async () => {
    if (saving) return;
    saving = true;
    try {
      const current = await window.desktop.getPreferences();
      if (!current.ok) throw new Error("load");
      const value: Preferences = { ...current.value };
      delete value.shortcuts;
      const saved = await window.desktop.setPreferences(value);
      if (!saved.ok) throw new Error("save");
      choices = {};
      const status = await window.desktop.getShortcutStatus();
      unavailable = status.ok ? status.value.unavailable : [];
      say("Every shortcut is back to its default.");
    } catch {
      say("The shortcuts could not be reset. Try again.");
    } finally {
      saving = false;
      render();
    }
  });

  dialog.addEventListener("close", () => {
    capturing = null;
  });

  return {
    activate() {
      capturing = null;
      say("");
      void (async () => {
        const [current, status] = await Promise.all([
          window.desktop.getPreferences(),
          window.desktop.getShortcutStatus(),
        ]);
        if (current.ok) choices = current.value.shortcuts ?? {};
        unavailable = status.ok ? status.value.unavailable : [];
        render();
      })();
      render();
    },
    map: () => resolveShortcuts(choices),
    load(saved) {
      choices = saved ?? {};
    },
  };
}
