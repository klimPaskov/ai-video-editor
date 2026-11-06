import assert from "node:assert/strict";
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { PreferencesStore } from "../../apps/desktop/src/preferences.ts";
import { assertPreferences } from "../../packages/domain/src/preferences.ts";

async function directory(): Promise<string> {
  const root = resolve("test-results/preferences");
  await mkdir(root, { recursive: true });
  return mkdtemp(join(root, "fixture-"));
}
test("preferences persist valid scales and serialize queued writes across store instances", async () => {
  const root = await directory();
  const first = new PreferencesStore(root);
  const second = new PreferencesStore(root);
  assert.deepEqual(await first.read(), { interfaceScale: 1 });
  assert.deepEqual(await readdir(root), []);
  const input = { interfaceScale: 1.25 };
  const initial = first.write(input);
  input.interfaceScale = 99;
  const next = second.write({ interfaceScale: 1.5 });
  assert.deepEqual(await initial, { interfaceScale: 1.25 });
  assert.deepEqual(await next, { interfaceScale: 1.5 });
  assert.deepEqual(await new PreferencesStore(root).read(), {
    interfaceScale: 1.5,
  });
  await first.write({ interfaceScale: 1 });
  assert.deepEqual(await second.read(), { interfaceScale: 1 });
  assert.deepEqual(await readdir(root), ["preferences.json"]);
});
test("invalid input is rejected without modifying existing settings", async () => {
  const root = await directory();
  const store = new PreferencesStore(root);
  await store.write({ interfaceScale: 1.25 });
  const before = await readFile(join(root, "preferences.json"));
  for (const value of [
    null,
    [],
    {},
    { interfaceScale: NaN },
    { interfaceScale: 3 },
    { interfaceScale: "1" },
    { interfaceScale: 1, path: "private" },
  ]) {
    assert.throws(() => assertPreferences(value));
    assert.throws(() => store.write(value));
  }
  assert.deepEqual(await readFile(join(root, "preferences.json")), before);
});
test("200% scale persists across reopening and can be restored to 100%", async () => {
  const root = await directory();
  const store = new PreferencesStore(root);
  assert.deepEqual(await store.write({ interfaceScale: 2 }), {
    interfaceScale: 2,
  });
  const reopened = new PreferencesStore(root);
  assert.deepEqual(await reopened.read(), { interfaceScale: 2 });
  assert.deepEqual(
    JSON.parse(await readFile(join(root, "preferences.json"), "utf8")),
    { interfaceScale: 2 },
  );
  await reopened.write({ interfaceScale: 1 });
  assert.deepEqual(await new PreferencesStore(root).read(), {
    interfaceScale: 1,
  });
});
test("corrupt settings survive failed reads and writes; queue recovers after external repair", async () => {
  const root = await directory();
  const store = new PreferencesStore(root);
  const path = join(root, "preferences.json");
  await writeFile(path, "{broken");
  await assert.rejects(store.read(), /could not be loaded/u);
  await assert.rejects(
    store.write({ interfaceScale: 1.5 }),
    /could not be saved/u,
  );
  assert.equal(await readFile(path, "utf8"), "{broken");
  await writeFile(path, '{"interfaceScale":1}');
  assert.deepEqual(await store.write({ interfaceScale: 1.25 }), {
    interfaceScale: 1.25,
  });
});
test("linked directories, hardlinked files and non-file settings are rejected without changing targets", async () => {
  const root = await directory();
  const real = join(root, "real");
  await mkdir(real);
  const linked = join(root, "linked");
  await symlink(real, linked, "junction");
  await assert.rejects(
    new PreferencesStore(linked).write({ interfaceScale: 1.25 }),
  );
  const original = join(root, "original.json");
  await writeFile(original, '{"interfaceScale":1}');
  await link(original, join(real, "preferences.json"));
  await assert.rejects(new PreferencesStore(real).read());
  await assert.rejects(
    new PreferencesStore(real).write({ interfaceScale: 1.5 }),
  );
  assert.equal(await readFile(original, "utf8"), '{"interfaceScale":1}');
  const blocked = join(root, "blocked");
  await mkdir(join(blocked, "preferences.json"), { recursive: true });
  await assert.rejects(
    new PreferencesStore(blocked).write({ interfaceScale: 1.5 }),
  );
  assert.throws(() => new PreferencesStore("relative/path"));
});

test("changed shortcuts are kept with the other settings, and every shortcut changed still fits", async () => {
  const root = await directory();
  const store = new PreferencesStore(root);
  const shortcuts = {
    "record.start": "CommandOrControl+Alt+R",
    "record.pause": "CommandOrControl+Alt+P",
    "record.stop": "CommandOrControl+Alt+S",
    "play.toggle": "P",
    "edit.split": "X",
    "edit.markIn": "J",
    "edit.markOut": "K",
    "edit.zoom": null,
    "edit.undo": "CommandOrControl+Alt+Z",
    "edit.redo": "CommandOrControl+Alt+Y",
    "frame.previous": "Up",
    "frame.next": "Down",
    "settings.open": "CommandOrControl+.",
  } as const;
  const saved = await store.write({
    interfaceScale: 1.25,
    theme: { id: "studio_dark" },
    shortcuts,
  });
  assert.deepEqual(saved.shortcuts, shortcuts);
  assert.deepEqual(await new PreferencesStore(root).read(), {
    interfaceScale: 1.25,
    theme: { id: "studio_dark" },
    shortcuts,
  });
  // A file far larger than any settings are is still refused.
  await writeFile(
    join(root, "preferences.json"),
    JSON.stringify({ interfaceScale: 1, pad: "x".repeat(9000) }),
  );
  await assert.rejects(new PreferencesStore(root).read());
});
