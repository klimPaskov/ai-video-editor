import assert from "node:assert/strict";
import test from "node:test";
import { ShortcutService } from "../../apps/desktop/src/shortcuts.ts";
import { assertPreferences } from "../../packages/domain/src/preferences.ts";
import {
  acceleratorFromEvent,
  allowedForScope,
  assertShortcutChoices,
  assertShortcutStatus,
  normalizeAccelerator,
  resolveShortcuts,
  shortcutActions,
} from "../../packages/domain/src/shortcuts.ts";

const press = (
  key: string,
  modifiers: Partial<{
    ctrlKey: boolean;
    metaKey: boolean;
    altKey: boolean;
    shiftKey: boolean;
  }> = {},
) => ({
  key,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...modifiers,
});

test("every action has a valid default, allowed for its scope, and no two share one", () => {
  const seen = new Set<string>();
  for (const action of shortcutActions) {
    assert.equal(normalizeAccelerator(action.default), action.default);
    assert.ok(allowedForScope(action.default, action.scope), action.id);
    assert.ok(!seen.has(action.default), `${action.id} repeats a default`);
    seen.add(action.default);
  }
  // Recording works from any program, so its three keys are global.
  assert.deepEqual(
    shortcutActions.filter((a) => a.scope === "global").map((a) => a.id),
    ["record.start", "record.pause", "record.stop"],
  );
});

test("accelerators are put in a fixed order and bad ones are refused", () => {
  assert.equal(
    normalizeAccelerator("Shift+CommandOrControl+f9"),
    null,
    "lower-case keys are not canonical",
  );
  assert.equal(
    normalizeAccelerator("Shift+CommandOrControl+F9"),
    "CommandOrControl+Shift+F9",
  );
  for (const bad of ["", "Ctrl+A", "Alt+Alt+A", "A+B", "Shift+", "F25", "Tab"])
    assert.equal(normalizeAccelerator(bad), null, bad);
});

test("a key press becomes an accelerator", () => {
  assert.equal(acceleratorFromEvent(press(" ")), "Space");
  assert.equal(acceleratorFromEvent(press("s")), "S");
  assert.equal(
    acceleratorFromEvent(press("z", { ctrlKey: true, shiftKey: true })),
    "CommandOrControl+Shift+Z",
  );
  assert.equal(
    acceleratorFromEvent(press("z", { metaKey: true })),
    "CommandOrControl+Z",
  );
  assert.equal(acceleratorFromEvent(press("ArrowLeft")), "Left");
  assert.equal(acceleratorFromEvent(press("F9", { altKey: true })), "Alt+F9");
  assert.equal(acceleratorFromEvent(press("Shift", { shiftKey: true })), null);
  assert.equal(acceleratorFromEvent(press("Dead")), null);
});

test("choices override defaults, null turns one off", () => {
  const resolved = resolveShortcuts({
    "record.start": "CommandOrControl+Alt+R",
    "edit.zoom": null,
  });
  assert.equal(resolved["record.start"], "CommandOrControl+Alt+R");
  assert.equal(resolved["edit.zoom"], null);
  assert.equal(resolved["edit.split"], "S");
});

test("global shortcuts cannot take a plain key from every other program", () => {
  assert.throws(
    () => assertShortcutChoices({ "record.stop": "S" }),
    /needs Ctrl, Alt or a function key/u,
  );
  assertShortcutChoices({ "record.stop": "F8" });
  assertShortcutChoices({ "record.stop": "Alt+X" });
  // A plain key is fine inside the app.
  assertShortcutChoices({ "edit.split": "X" });
});

test("two actions cannot share a shortcut, including a default", () => {
  assert.throws(
    () => assertShortcutChoices({ "edit.zoom": "S" }),
    /use the same shortcut/u,
  );
  // Moving one away first frees the key.
  assertShortcutChoices({ "edit.split": "X", "edit.zoom": "S" });
  assert.throws(
    () => assertShortcutChoices({ nonsense: "S" } as never),
    /could not be read/u,
  );
});

test("preferences carry shortcuts and still refuse unknown fields", () => {
  assertPreferences({ interfaceScale: 1, shortcuts: { "edit.split": "X" } });
  assert.throws(() =>
    assertPreferences({ interfaceScale: 1, shortcuts: { "edit.split": "x" } }),
  );
  assert.throws(() =>
    assertPreferences({ interfaceScale: 1, shortcut: {} } as never),
  );
});

function fakeSystem(refuse: string[] = []) {
  const live = new Map<string, () => void>();
  return {
    live,
    register(accelerator: string, callback: () => void): boolean {
      if (refuse.includes(accelerator)) return false;
      live.set(accelerator, callback);
      return true;
    },
    unregister(accelerator: string): void {
      live.delete(accelerator);
    },
  };
}

test("the recording keys are registered with the system and fire their action", () => {
  const system = fakeSystem();
  const fired: string[] = [];
  const service = new ShortcutService(system, (id) => fired.push(id));
  service.apply(undefined);
  assert.deepEqual([...system.live.keys()].sort(), [
    "CommandOrControl+Shift+F10",
    "CommandOrControl+Shift+F11",
    "CommandOrControl+Shift+F9",
  ]);
  system.live.get("CommandOrControl+Shift+F10")!();
  system.live.get("CommandOrControl+Shift+F11")!();
  assert.deepEqual(fired, ["record.pause", "record.stop"]);
  assert.deepEqual(service.status(), { unavailable: [] });
});

test("a key another program owns is reported and the others still work", () => {
  const system = fakeSystem(["CommandOrControl+Shift+F10"]);
  const service = new ShortcutService(system, () => undefined);
  service.apply(undefined);
  assert.deepEqual(service.status(), { unavailable: ["record.pause"] });
  assert.equal(system.live.size, 2);
  assertShortcutStatus(service.status());
});

test("changing, turning off and releasing shortcuts leaves nothing behind", () => {
  const system = fakeSystem();
  const service = new ShortcutService(system, () => undefined);
  service.apply({ "record.start": "Alt+F1", "record.stop": null });
  assert.deepEqual([...system.live.keys()].sort(), [
    "Alt+F1",
    "CommandOrControl+Shift+F10",
  ]);
  service.apply(undefined);
  assert.equal(system.live.size, 3);
  assert.ok(!system.live.has("Alt+F1"));
  service.release();
  assert.equal(system.live.size, 0);
});

test("a throwing system registry is treated as a refusal", () => {
  const service = new ShortcutService(
    {
      register() {
        throw new Error("denied");
      },
      unregister() {},
    },
    () => undefined,
  );
  service.apply(undefined);
  assert.deepEqual(service.status().unavailable.sort(), [
    "record.pause",
    "record.start",
    "record.stop",
  ]);
});
