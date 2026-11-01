import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import {
  MediaToolsError,
  mediaToolsMissingMessage,
  pathWithMediaTools,
  resolveMediaTools,
} from "../../apps/desktop/src/media-tools.ts";

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");

const contents: Record<string, string> = {
  "ffmpeg.exe": "synthetic ffmpeg bytes, never executed",
  "ffprobe.exe": "synthetic ffprobe bytes, never executed",
  "avcodec-62.dll": "synthetic library bytes",
  "LICENSE.txt": "synthetic license",
};

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "media-tools-"));
  const directory = join(root, "ffmpeg");
  await mkdir(directory);
  for (const [name, text] of Object.entries(contents))
    await writeFile(join(directory, name), text);
  const manifest = {
    schemaVersion: 1,
    name: "ffmpeg",
    version: "n0.0.0-test",
    platform: "win32",
    arch: "x64",
    license: "LGPL-3.0-or-later",
    ffmpeg: "ffmpeg.exe",
    ffprobe: "ffprobe.exe",
    files: Object.entries(contents).map(([name, text]) => ({
      name,
      size: Buffer.byteLength(text),
      sha256: hash(text),
    })),
  };
  const manifestPath = join(directory, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest));
  return { root, directory, manifest, manifestPath };
}

test("a verified bundled folder supplies absolute ffmpeg and ffprobe paths", async () => {
  const files = await fixture();
  try {
    const tools = await resolveMediaTools(files.root, "win32", "x64");
    assert.equal(tools.source, "bundled");
    assert.equal(tools.ffmpeg.endsWith("ffmpeg.exe"), true);
    assert.equal(tools.ffprobe.endsWith("ffprobe.exe"), true);
    assert.ok(tools.directory);
    assert.equal(
      pathWithMediaTools(tools, "C:\\Windows"),
      `${tools.directory}${delimiter}C:\\Windows`,
    );
    assert.equal(pathWithMediaTools(tools, undefined), tools.directory);
  } finally {
    await rm(files.root, { recursive: true, force: true });
  }
});

test("a changed, missing, extra or mislabelled file is rejected with the plain message", async () => {
  const files = await fixture();
  try {
    await writeFile(join(files.directory, "avcodec-62.dll"), "tampered");
    await assert.rejects(
      resolveMediaTools(files.root, "win32", "x64"),
      (error: unknown) =>
        error instanceof MediaToolsError &&
        error.message === mediaToolsMissingMessage,
    );
    await writeFile(
      join(files.directory, "avcodec-62.dll"),
      contents["avcodec-62.dll"]!,
    );
    await resolveMediaTools(files.root, "win32", "x64");
    await assert.rejects(
      resolveMediaTools(files.root, "linux", "x64"),
      MediaToolsError,
    );
    await assert.rejects(
      resolveMediaTools(files.root, "win32", "arm64"),
      MediaToolsError,
    );
    await rm(join(files.directory, "ffprobe.exe"));
    await assert.rejects(
      resolveMediaTools(files.root, "win32", "x64"),
      MediaToolsError,
    );
  } finally {
    await rm(files.root, { recursive: true, force: true });
  }
});

test("manifest entries that are unsafe, duplicated, unlisted or malformed are rejected", async () => {
  const files = await fixture();
  try {
    const listed = files.manifest.files;
    for (const patch of [
      { files: [...listed, { ...listed[0]! }] },
      { files: [...listed, { name: "..\\x.dll", size: 1, sha256: hash("x") }] },
      { files: [...listed, { name: "a/b.dll", size: 1, sha256: hash("x") }] },
      { files: listed.filter((file) => file.name !== "LICENSE.txt") },
      { files: [{ ...listed[0]!, sha256: "invalid" }, ...listed.slice(1)] },
      { files: [] },
      { ffmpeg: "missing.exe" },
      { schemaVersion: 2 },
      { unexpected: true },
    ]) {
      await writeFile(
        files.manifestPath,
        JSON.stringify({ ...files.manifest, ...patch }),
      );
      await assert.rejects(
        resolveMediaTools(files.root, "win32", "x64"),
        MediaToolsError,
      );
    }
    for (const text of ["{", "null", "[]", " ".repeat(16_385)]) {
      await writeFile(files.manifestPath, text);
      await assert.rejects(
        resolveMediaTools(files.root, "win32", "x64"),
        MediaToolsError,
      );
    }
    await rm(files.manifestPath);
    await assert.rejects(
      resolveMediaTools(files.root, "win32", "x64"),
      MediaToolsError,
    );
    assert.ok((await readFile(join(files.directory, "ffmpeg.exe"))).length);
  } finally {
    await rm(files.root, { recursive: true, force: true });
  }
});

test("a redirected folder is rejected and a relative resources path is refused", async () => {
  const files = await fixture();
  const redirected = await mkdtemp(join(tmpdir(), "media-tools-link-"));
  try {
    await symlink(
      files.directory,
      join(redirected, "ffmpeg"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await assert.rejects(
      resolveMediaTools(redirected, "win32", "x64"),
      MediaToolsError,
    );
    await assert.rejects(
      resolveMediaTools("relative", "win32", "x64"),
      MediaToolsError,
    );
  } finally {
    await rm(redirected, { recursive: true, force: true });
    await rm(files.root, { recursive: true, force: true });
  }
});

test("without a bundled folder Windows reports the problem and other systems use PATH", async () => {
  const root = await mkdtemp(join(tmpdir(), "media-tools-none-"));
  try {
    await assert.rejects(
      resolveMediaTools(root, "win32", "x64"),
      (error: unknown) =>
        error instanceof MediaToolsError &&
        /missing or damaged/u.test(error.message) &&
        !error.message.includes(root),
    );
    const system = await resolveMediaTools(root, "linux", "x64");
    assert.deepEqual(system, {
      ffmpeg: "ffmpeg",
      ffprobe: "ffprobe",
      directory: null,
      source: "system",
    });
    assert.equal(pathWithMediaTools(system, "/usr/bin"), "/usr/bin");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
