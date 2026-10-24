import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  recordExportFolder,
  redactPaths,
  sweepPartialExports,
  sweepTemporaryFolders,
} from "../../apps/desktop/src/private-notes.ts";

const old = new Date(Date.now() - 3_600_000);
const uuid = "d7460943-c910-4680-878f-9e95b156a8a9";

test("home and app data paths are replaced in a private note", () => {
  const home = homedir();
  const note = `failed at ${home}/Videos/clip.mp4 and ${home.replaceAll("\\", "/")}/x, data in /srv/app/data/exports/a.json`;
  const cleaned = redactPaths(note, [
    { path: "/srv/app/data", as: "<app data>" },
  ]);
  assert.doesNotMatch(
    cleaned,
    new RegExp(home.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&"), "u"),
  );
  assert.match(cleaned, /~\/Videos\/clip\.mp4/u);
  assert.match(cleaned, /<app data>\/exports\/a\.json/u);
  // Short or empty roots never turn text into noise.
  assert.equal(redactPaths("a/b", [{ path: "/", as: "X" }]), "a/b");
});

test("old scratch folders of ours are swept; recent, foreign and non-folders stay", async () => {
  const root = await mkdtemp(join(tmpdir(), "sweep-"));
  try {
    const mine = [
      "ai-video-editor-graphics-AbC123",
      "ai-video-editor-frames-x9",
      "ai-video-editor-check-Q1",
    ];
    const kept = [
      "ai-video-editor-graphics-Recent1",
      "ai-video-editor-other-Zz9",
      "someone-elses-folder",
    ];
    for (const name of [...mine, ...kept]) {
      await mkdir(join(root, name));
      await writeFile(join(root, name, "file"), "x");
      if (!name.endsWith("Recent1")) await utimes(join(root, name), old, old);
    }
    // A file with a matching name is not a folder of ours.
    await writeFile(join(root, "ai-video-editor-frames-file"), "x");
    await utimes(join(root, "ai-video-editor-frames-file"), old, old);
    assert.equal(await sweepTemporaryFolders(root), 3);
    assert.deepEqual(
      (await readdir(root)).sort(),
      [...kept, "ai-video-editor-frames-file"].sort(),
    );
    assert.equal(await sweepTemporaryFolders(join(root, "missing")), 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("partial exports of recorded folders are swept once old, nothing else", async () => {
  const root = await mkdtemp(join(tmpdir(), "sweep-"));
  try {
    const records = join(root, "records");
    const videos = join(root, "Videos");
    const elsewhere = join(root, "Elsewhere");
    for (const folder of [videos, elsewhere]) await mkdir(folder);
    await recordExportFolder(records, videos);
    await recordExportFolder(records, videos);
    const partial = `.Edit master.mkv.${uuid}.partial`;
    const recent = `.Recent.mkv.${uuid.replace("d7", "e7")}.partial`;
    for (const [folder, name, aged] of [
      [videos, partial, true],
      [videos, recent, false],
      [videos, "Edit master.mkv", true],
      [videos, ".hidden-project", true],
      [elsewhere, partial, true],
    ] as const) {
      await mkdir(join(folder, name));
      await writeFile(join(folder, name, "export.mkv"), "x");
      if (aged) await utimes(join(folder, name), old, old);
    }
    assert.equal(await sweepPartialExports(records), 1);
    assert.deepEqual(
      (await readdir(videos)).sort(),
      [".hidden-project", "Edit master.mkv", recent].sort(),
    );
    // A folder that was never recorded is never touched.
    assert.deepEqual(await readdir(elsewhere), [partial]);
    assert.equal(await sweepPartialExports(join(root, "none")), 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
