/**
 * Keyboard shortcuts the user can change (Settings, Shortcuts). The actions,
 * their defaults, the key format and the rules live here so the window, the
 * main process and the tests agree.
 *
 * A shortcut is written like Electron accelerators: modifiers in a fixed
 * order, then one key, joined by "+": "CommandOrControl+Shift+F9".
 * `CommandOrControl` is Ctrl on Windows and Linux and Command on macOS.
 * Global shortcuts work while another program is in front (recording runs
 * with the window out of the way); the others act only inside the app.
 */

export type ShortcutScope = "global" | "app";

export interface ShortcutAction {
  id: string;
  label: string;
  scope: ShortcutScope;
  /** The default accelerator. */
  default: string;
}

export const shortcutActions = [
  {
    id: "record.start",
    label: "Start recording",
    scope: "global",
    default: "CommandOrControl+Shift+F9",
  },
  {
    id: "record.pause",
    label: "Pause or resume recording",
    scope: "global",
    default: "CommandOrControl+Shift+F10",
  },
  {
    id: "record.stop",
    label: "Stop recording",
    scope: "global",
    default: "CommandOrControl+Shift+F11",
  },
  {
    id: "play.toggle",
    label: "Play or pause",
    scope: "app",
    default: "Space",
  },
  {
    id: "edit.split",
    label: "Split at the playhead",
    scope: "app",
    default: "S",
  },
  {
    id: "edit.markIn",
    label: "Mark the start of a range",
    scope: "app",
    default: "I",
  },
  {
    id: "edit.markOut",
    label: "Mark the end of a range",
    scope: "app",
    default: "O",
  },
  { id: "edit.zoom", label: "Add a zoom", scope: "app", default: "Z" },
  {
    id: "edit.undo",
    label: "Undo",
    scope: "app",
    default: "CommandOrControl+Z",
  },
  {
    id: "edit.redo",
    label: "Redo",
    scope: "app",
    default: "CommandOrControl+Shift+Z",
  },
  {
    id: "frame.previous",
    label: "Previous frame",
    scope: "app",
    default: "Left",
  },
  { id: "frame.next", label: "Next frame", scope: "app", default: "Right" },
  {
    id: "settings.open",
    label: "Open Settings",
    scope: "app",
    default: "CommandOrControl+,",
  },
] as const satisfies readonly ShortcutAction[];

export type ShortcutId = (typeof shortcutActions)[number]["id"];

/** Chosen shortcuts by action; `null` turns an action's shortcut off. */
export type ShortcutChoices = Partial<Record<ShortcutId, string | null>>;

const modifierOrder = ["CommandOrControl", "Alt", "Shift"] as const;
const letters = /^[A-Z]$/u;
const digits = /^[0-9]$/u;
const functionKeys = /^F([1-9]|1[0-9]|2[0-4])$/u;
const namedKeys = new Set([
  "Space",
  "Left",
  "Right",
  "Up",
  "Down",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "Backspace",
  "Delete",
  ",",
  ".",
  "-",
  "=",
]);

function validKey(key: string): boolean {
  return (
    letters.test(key) ||
    digits.test(key) ||
    functionKeys.test(key) ||
    namedKeys.has(key)
  );
}

interface Parsed {
  modifiers: string[];
  key: string;
}

function parse(text: string): Parsed | null {
  if (typeof text !== "string" || text.length === 0 || text.length > 60)
    return null;
  // "+" is the separator, so the plus key cannot be bound.
  const parts = text.split("+");
  const key = parts.pop() ?? "";
  if (!validKey(key)) return null;
  const modifiers: string[] = [];
  for (const part of parts) {
    if (!(modifierOrder as readonly string[]).includes(part)) return null;
    if (modifiers.includes(part)) return null;
    modifiers.push(part);
  }
  return { modifiers, key };
}

/** The canonical form of an accelerator, or null when it is not valid. */
export function normalizeAccelerator(text: string): string | null {
  const parsed = parse(text);
  if (!parsed) return null;
  const ordered = modifierOrder.filter((modifier) =>
    parsed.modifiers.includes(modifier),
  );
  return [...ordered, parsed.key].join("+");
}

/**
 * A global shortcut must not steal an ordinary key from every other program:
 * it needs Ctrl/Command or Alt, or be a function key.
 */
export function allowedForScope(
  accelerator: string,
  scope: ShortcutScope,
): boolean {
  const parsed = parse(accelerator);
  if (!parsed) return false;
  if (scope === "app") return true;
  return (
    parsed.modifiers.includes("CommandOrControl") ||
    parsed.modifiers.includes("Alt") ||
    functionKeys.test(parsed.key)
  );
}

export function shortcutAction(id: string): ShortcutAction | undefined {
  return shortcutActions.find((action) => action.id === id);
}

/** The accelerator of every action: the user's choice, else the default. */
export function resolveShortcuts(
  choices: ShortcutChoices | undefined,
): Record<ShortcutId, string | null> {
  const resolved = {} as Record<ShortcutId, string | null>;
  for (const action of shortcutActions) {
    const chosen = choices?.[action.id];
    resolved[action.id] = chosen === undefined ? action.default : chosen;
  }
  return resolved;
}

const eventNames: Record<string, string> = {
  " ": "Space",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  ArrowUp: "Up",
  ArrowDown: "Down",
};

/** What a key press means as an accelerator; null for a lone modifier or an unsupported key. */
export function acceleratorFromEvent(event: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}): string | null {
  const raw = eventNames[event.key] ?? event.key;
  const key = raw.length === 1 ? raw.toUpperCase() : raw;
  const modifiers: string[] = [];
  if (event.ctrlKey || event.metaKey) modifiers.push("CommandOrControl");
  if (event.altKey) modifiers.push("Alt");
  if (event.shiftKey) modifiers.push("Shift");
  return normalizeAccelerator([...modifiers, key].join("+"));
}

/** Throws a plain sentence when the choices cannot be used. */
export function assertShortcutChoices(
  value: unknown,
): asserts value is ShortcutChoices {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Shortcuts could not be read.");
  const choices = value as Record<string, unknown>;
  for (const [id, chosen] of Object.entries(choices)) {
    const action = shortcutAction(id);
    if (!action) throw new Error("Shortcuts could not be read.");
    if (chosen === null) continue;
    if (typeof chosen !== "string" || normalizeAccelerator(chosen) !== chosen)
      throw new Error(`The shortcut for “${action.label}” is not valid.`);
    if (!allowedForScope(chosen, action.scope))
      throw new Error(
        `“${action.label}” works in other programs too, so its shortcut needs Ctrl, Alt or a function key.`,
      );
  }
  const used = new Map<string, string>();
  for (const [id, accelerator] of Object.entries(
    resolveShortcuts(choices as ShortcutChoices),
  )) {
    if (accelerator === null) continue;
    const other = used.get(accelerator);
    if (other)
      throw new Error(
        `“${shortcutAction(id)!.label}” and “${other}” use the same shortcut.`,
      );
    used.set(accelerator, shortcutAction(id)!.label);
  }
}

/** Which global shortcuts the system refused (another program owns the keys). */
export interface ShortcutStatus {
  unavailable: ShortcutId[];
}

export function assertShortcutStatus(
  value: unknown,
): asserts value is ShortcutStatus {
  const ok =
    !!value &&
    typeof value === "object" &&
    Object.keys(value).join() === "unavailable" &&
    Array.isArray((value as ShortcutStatus).unavailable) &&
    (value as ShortcutStatus).unavailable.every(
      (id) => shortcutAction(id)?.scope === "global",
    ) &&
    new Set((value as ShortcutStatus).unavailable).size ===
      (value as ShortcutStatus).unavailable.length;
  if (!ok) throw new Error("Shortcut status could not be read.");
}

/** Whether a shortcut id is one of the known actions. */
export function isShortcutId(value: unknown): value is ShortcutId {
  return typeof value === "string" && shortcutAction(value) !== undefined;
}
