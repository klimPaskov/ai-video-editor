import assert from "node:assert/strict";
import {
  appendFile,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { probeSoundFile } from "../../packages/media-engine/src/sound-probe.ts";
import { runProcess } from "../../packages/media-engine/src/process.ts";
import {
  SoundAssetError,
  SoundAssetStore,
  soundNameFrom,
} from "../../packages/project-store/src/sounds.ts";

const project = "project-sounds-001";

async function wav(path: string, frequency = 440, length = 1) {
  await runProcess({
    executable: "ffmpeg",
    args: [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=${frequency}:sample_rate=44100:duration=${length}`,
      "-ac",
      "1",
      "-y",
      path,
    ],
    timeoutMs: 60_000,
  });
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "sound-assets-"));
  const store = new SoundAssetStore(join(root, "store"), (path, signal) =>
    probeSoundFile(path, signal ? { signal } : {}),
  );
  return { root, store, folder: join(root, "store", project, "sounds") };
}

const code = (expected: SoundAssetError["code"]) => (error: unknown) =>
  error instanceof SoundAssetError && error.code === expected;

test("an audio file is copied into the project, probed and listed", async () => {
  const { root, store, folder } = await fixture();
  try {
    assert.deepEqual(await store.list(project), []);
    const source = join(root, "Theme Song.wav");
    await wav(source, 440, 1);
    const asset = await store.import(project, source);
    assert.equal(asset.name, "Theme Song");
    assert.ok(Math.abs(asset.duration_us - 1_000_000) < 30_000);
    assert.equal(asset.sample_rate, 44_100);
    assert.equal(asset.channels, 1);
    assert.deepEqual(await store.list(project), [asset]);
    // The same bytes are the same asset; nothing is stored twice.
    const copy = join(root, "Copy.wav");
    await copyFile(source, copy);
    assert.deepEqual(await store.import(project, copy), asset);
    const names = await readdir(folder);
    assert.equal(names.length, 2);
    assert.ok(names.includes("index.json"));
    assert.ok(names.some((name) => name.startsWith(asset.asset_id)));
    // The file checks out against its hash and the layer's expected hash.
    const resolved = await store.resolve(project, asset.asset_id, asset.sha256);
    assert.equal(resolved.asset.asset_id, asset.asset_id);
    assert.ok(resolved.path.endsWith(".wav"));
    // A different file is a second asset.
    const other = join(root, "other.wav");
    await wav(other, 660, 2);
    assert.equal((await store.import(project, other)).name, "other");
    assert.equal((await store.list(project)).length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("files that are not audio, links, empty files and bad ids are refused cleanly", async () => {
  const { root, store, folder } = await fixture();
  try {
    const text = join(root, "notes.txt");
    await writeFile(text, "this is not audio");
    await assert.rejects(store.import(project, text), code("not_audio"));
    const empty = join(root, "empty.wav");
    await writeFile(empty, "");
    await assert.rejects(store.import(project, empty), code("too_large"));
    await assert.rejects(
      store.import(project, join(root, "missing.wav")),
      code("invalid"),
    );
    await assert.rejects(store.import(project, root), code("invalid"));
    const real = join(root, "real.wav");
    await wav(real);
    const link = join(root, "link.wav");
    let linked = true;
    await symlink(real, link).catch(() => {
      linked = false;
    });
    if (linked)
      await assert.rejects(store.import(project, link), code("invalid"));
    // Nothing partial is left behind by any refusal.
    const names = await readdir(folder).catch(() => []);
    assert.deepEqual(
      names.filter((name) => name !== "index.json"),
      [],
    );
    await assert.rejects(store.list("../escape"), code("invalid"));
    await assert.rejects(store.resolve(project, "../x"), code("invalid"));
    await assert.rejects(
      store.resolve(project, "asset-unknown-1"),
      code("missing"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a changed or replaced file is detected before use", async () => {
  const { root, store, folder } = await fixture();
  try {
    const source = join(root, "music.wav");
    await wav(source);
    const asset = await store.import(project, source);
    await assert.rejects(
      store.resolve(project, asset.asset_id, "f".repeat(64)),
      code("changed"),
    );
    const stored = (await readdir(folder)).find((name) =>
      name.startsWith(asset.asset_id),
    )!;
    await appendFile(join(folder, stored), "x");
    await assert.rejects(
      store.resolve(project, asset.asset_id),
      code("changed"),
    );
    // Same size, other bytes: the hash catches it.
    await rm(join(folder, stored));
    const bytes = Buffer.alloc(asset.size_bytes, 1);
    await writeFile(join(folder, stored), bytes);
    await assert.rejects(
      store.resolve(project, asset.asset_id),
      code("changed"),
    );
    await rm(join(folder, stored));
    await assert.rejects(
      store.resolve(project, asset.asset_id),
      code("missing"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("imports at the same time keep a consistent list", async () => {
  const { root, store } = await fixture();
  try {
    const files: string[] = [];
    for (let index = 0; index < 4; index++) {
      const file = join(root, `tone-${index}.wav`);
      await wav(file, 300 + index * 100, 1);
      files.push(file);
    }
    const added = await Promise.all(
      files.map((file) => store.import(project, file)),
    );
    const listed = await store.list(project);
    assert.equal(listed.length, 4);
    assert.deepEqual(
      new Set(listed.map((asset) => asset.asset_id)),
      new Set(added.map((asset) => asset.asset_id)),
    );
    // A damaged index is refused, not guessed at.
    await mkdir(join(root, "store", "other-project", "sounds"), {
      recursive: true,
    });
    await writeFile(
      join(root, "store", "other-project", "sounds", "index.json"),
      '[{"asset_id":"a"}]',
    );
    await assert.rejects(store.list("other-project"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("display names come from the file name only", () => {
  assert.equal(soundNameFrom("/home/me/music/Intro Theme.mp3"), "Intro Theme");
  assert.equal(
    soundNameFrom("C:\\Users\\me\\sfx\\whoosh.final.wav"),
    "whoosh.final",
  );
  assert.equal(soundNameFrom("/x/a\u0000b\u001fc.wav"), "a b c");
  assert.equal([...soundNameFrom(`/x/${"é".repeat(300)}.wav`)].length, 80);
});
