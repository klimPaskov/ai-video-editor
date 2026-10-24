import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cachedPackageFile } from "../../apps/desktop/src/composition-server.ts";

const pinned = (file: string) => ({ name: "gsap", version: "3.14.2", file });
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

test("a package file is fetched once, kept with its hash and served from the cache", async () => {
  const root = await mkdtemp(join(tmpdir(), "package-cache-"));
  try {
    const fetched: string[] = [];
    const fetch = async (url: string) => {
      fetched.push(url);
      return Buffer.from(`content of ${url}`);
    };
    const first = await cachedPackageFile(root, pinned("dist/a.js"), fetch);
    const again = await cachedPackageFile(root, pinned("dist/a.js"), fetch);
    assert.equal(first.toString(), again.toString());
    assert.deepEqual(fetched, [
      "https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/a.js",
    ]);
    const folder = join(root, "gsap@3.14.2", "dist");
    assert.deepEqual((await readdir(folder)).sort(), ["a.js", "a.js.sha256"]);
    assert.equal(
      (await readFile(join(folder, "a.js.sha256"), "utf8")).trim(),
      hash(first.toString()),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a changed cache entry is fetched again, an older one without a hash is adopted", async () => {
  const root = await mkdtemp(join(tmpdir(), "package-cache-"));
  try {
    let fetches = 0;
    const fetch = async () => {
      fetches++;
      return Buffer.from("fresh");
    };
    const folder = join(root, "gsap@3.14.2", "dist");
    await cachedPackageFile(root, pinned("dist/a.js"), fetch);
    // Damaged or replaced bytes do not match the kept hash: fetched again.
    await writeFile(join(folder, "a.js"), "tampered");
    assert.equal(
      (await cachedPackageFile(root, pinned("dist/a.js"), fetch)).toString(),
      "fresh",
    );
    assert.equal(fetches, 2);
    // A file from before hashes were kept is adopted, not fetched, so an
    // offline cache keeps working; its hash is then recorded.
    await writeFile(join(folder, "old.js"), "legacy");
    assert.equal(
      (await cachedPackageFile(root, pinned("dist/old.js"), fetch)).toString(),
      "legacy",
    );
    assert.equal(fetches, 2);
    assert.equal(
      (await readFile(join(folder, "old.js.sha256"), "utf8")).trim(),
      hash("legacy"),
    );
    // Nothing cached and no network: an error, never an empty file.
    await assert.rejects(
      cachedPackageFile(root, pinned("dist/missing.js"), async () => {
        throw new Error("offline");
      }),
    );
    assert.equal((await readdir(folder)).includes("missing.js"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the cache stays within its quota by dropping the oldest files, never the new one", async () => {
  const root = await mkdtemp(join(tmpdir(), "package-cache-"));
  try {
    const folder = join(root, "gsap@3.14.2", "dist");
    await mkdir(folder, { recursive: true });
    for (const [index, name] of ["old", "middle"].entries()) {
      await writeFile(join(folder, `${name}.js`), "x".repeat(40));
      await writeFile(join(folder, `${name}.js.sha256`), hash("x".repeat(40)));
      const time = new Date(Date.now() - (2 - index) * 60_000);
      await utimes(join(folder, `${name}.js`), time, time);
    }
    await cachedPackageFile(
      root,
      pinned("dist/new.js"),
      async () => Buffer.from("y".repeat(40)),
      100,
    );
    assert.deepEqual((await readdir(folder)).sort(), [
      "middle.js",
      "middle.js.sha256",
      "new.js",
      "new.js.sha256",
    ]);
    // A single file over the quota is still served and kept.
    const big = await cachedPackageFile(
      root,
      pinned("dist/big.js"),
      async () => Buffer.from("z".repeat(500)),
      100,
    );
    assert.equal(big.length, 500);
    assert.ok((await readdir(folder)).includes("big.js"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
