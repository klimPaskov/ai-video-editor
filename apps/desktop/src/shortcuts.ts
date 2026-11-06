import {
  resolveShortcuts,
  shortcutAction,
  shortcutActions,
  type ShortcutChoices,
  type ShortcutId,
  type ShortcutStatus,
} from "../../../packages/domain/src/shortcuts.ts";

/** The part of Electron's `globalShortcut` this service uses. */
export interface GlobalShortcuts {
  register(accelerator: string, callback: () => void): boolean;
  unregister(accelerator: string): void;
}

/**
 * Registers the global shortcuts (the recording keys) with the system and
 * says which ones it refused. The in-app shortcuts are handled by the window
 * itself. Registering again replaces the earlier set, so a change in Settings
 * takes effect at once.
 */
export class ShortcutService {
  private readonly registered = new Map<ShortcutId, string>();
  private refused: ShortcutId[] = [];

  private readonly system: GlobalShortcuts;
  private readonly fired: (id: ShortcutId) => void;

  constructor(system: GlobalShortcuts, fired: (id: ShortcutId) => void) {
    this.system = system;
    this.fired = fired;
  }

  apply(choices: ShortcutChoices | undefined): void {
    this.release();
    this.refused = [];
    const resolved = resolveShortcuts(choices);
    for (const action of shortcutActions) {
      if (action.scope !== "global") continue;
      const accelerator = resolved[action.id];
      if (accelerator === null) continue;
      let accepted = false;
      try {
        accepted = this.system.register(accelerator, () =>
          this.fired(action.id),
        );
      } catch {
        accepted = false;
      }
      if (accepted) this.registered.set(action.id, accelerator);
      else this.refused.push(action.id);
    }
  }

  status(): ShortcutStatus {
    return { unavailable: [...this.refused] };
  }

  /** Gives every shortcut back to the system (on quit and before a change). */
  release(): void {
    for (const [id, accelerator] of this.registered) {
      if (shortcutAction(id)) this.system.unregister(accelerator);
    }
    this.registered.clear();
  }
}
