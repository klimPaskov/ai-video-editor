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
import { join } from "node:path";
import test from "node:test";
import { crc32, deflateRawSync, gzipSync } from "node:zlib";
import {
  ArchiveError,
  extractTarGzFiles,
  extractZipFiles,
  isSafeArchivePath,
  listZip,
} from "../../scripts/windows/archives.ts";
import {
  isExcludedPath,
  keepFile,
  unpinnedPackages,
} from "../../scripts/windows/dependencies.ts";
import { integrityMatches } from "../../scripts/windows/download.ts";
import {
  listPayload,
  nsisPath,
  uninstallList,
  versionQuad,
} from "../../scripts/windows/installer.ts";
import {
  assertCodexLockEntry,
  assertLgplConfiguration,
  externalLibraries,
  ffmpegNotice,
  loadWindowsPins,
} from "../../scripts/windows/sidecars.ts";

const root = join(import.meta.dirname, "../..");

// The configuration string of the pinned BtbN win64 LGPL shared build.
const pinnedConfiguration =
  "--prefix=/ffbuild/prefix --pkg-config-flags=--static --cross-prefix=x86_64-w64-mingw32- --arch=x86_64 --target-os=mingw32 --enable-version3 --disable-debug --enable-shared --disable-static --enable-libass --enable-libfreetype --enable-libopenh264 --enable-libvpx --enable-libopus --disable-libx264 --disable-libx265 --extra-version=20260930";

test("the pins file names the lockfile's Windows Codex tarball and a complete FFmpeg pin", async () => {
  const pins = await loadWindowsPins();
  const lock = JSON.parse(
    await readFile(join(root, "package-lock.json"), "utf8"),
  );
  assertCodexLockEntry(pins.codex, lock);
  assert.throws(() =>
    assertCodexLockEntry(
      {
        ...pins.codex,
        download: { ...pins.codex.download, integrity: "sha512-AAAA" },
      },
      lock,
    ),
  );
  assert.match(pins.ffmpeg.download.sha256, /^[a-f0-9]{64}$/u);
  assert.match(pins.codex.download.sha256, /^[a-f0-9]{64}$/u);
  assert.match(pins.ffmpeg.ffmpegCommit, /^[a-f0-9]{40}$/u);
  assert.match(pins.ffmpeg.recipeCommit, /^[a-f0-9]{40}$/u);
  assert.equal(pins.ffmpeg.license, "LGPL-3.0-or-later");
  assert.ok(pins.ffmpeg.files.includes("bin/ffmpeg.exe"));
  assert.ok(pins.ffmpeg.files.includes("bin/ffprobe.exe"));
  assert.ok(pins.ffmpeg.files.includes("LICENSE.txt"));
  // No GPL-only tool ships: the pinned archive is the lgpl variant.
  assert.match(pins.ffmpeg.download.url, /win64-lgpl-shared/u);
  assert.equal(pins.electron, "44.2.0");
});

test("only an LGPL, shared, Windows x64 FFmpeg configuration is accepted", () => {
  assertLgplConfiguration(pinnedConfiguration);
  for (const bad of [
    "--enable-gpl",
    "--enable-nonfree",
    "--enable-libx264",
    "--enable-libx265",
    "--enable-libfdk-aac",
  ])
    assert.throws(
      () => assertLgplConfiguration(`${pinnedConfiguration} ${bad}`),
      /not LGPL-redistributable/u,
    );
  assert.throws(() =>
    assertLgplConfiguration(
      pinnedConfiguration.replace("--enable-shared", "--enable-static"),
    ),
  );
  assert.throws(() =>
    assertLgplConfiguration(
      pinnedConfiguration.replace("--enable-version3", ""),
    ),
  );
  assert.throws(() =>
    assertLgplConfiguration(
      pinnedConfiguration.replace("--target-os=mingw32", "--target-os=linux"),
    ),
  );
  assert.deepEqual(externalLibraries(pinnedConfiguration), [
    "libass",
    "libfreetype",
    "libopenh264",
    "libopus",
    "libvpx",
  ]);
});

test("the FFmpeg notice states version, licence, source and libraries without local paths", async () => {
  const pins = await loadWindowsPins();
  const notice = ffmpegNotice(pins.ffmpeg, pinnedConfiguration);
  assert.match(notice, /LGPL-3\.0-or-later/u);
  assert.ok(notice.includes(pins.ffmpeg.ffmpegCommit));
  assert.ok(notice.includes(pins.ffmpeg.recipeCommit));
  assert.match(notice, /libopenh264/u);
  assert.doesNotMatch(notice, /[A-Z]:\\|\/home\//u);
});

function zipFile(
  entries: { name: string; data: Buffer; method?: 0 | 8; mode?: number }[],
): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const method = entry.method ?? 8;
    const body = method === 8 ? deflateRawSync(entry.data) : entry.data;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc32(entry.data), 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc32(entry.data), 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

test("the ZIP reader extracts requested files, verifies them and refuses links and traversal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "win-zip-"));
  try {
    const exe = Buffer.from("synthetic exe bytes ".repeat(50));
    const path = join(directory, "a.zip");
    await writeFile(
      path,
      zipFile([
        { name: "root/bin/ffmpeg.exe", data: exe },
        { name: "root/LICENSE.txt", data: Buffer.from("licence"), method: 0 },
        { name: "root/link", data: Buffer.from("target"), mode: 0o120777 },
        { name: "../escape.txt", data: Buffer.from("x") },
      ]),
    );
    const written = new Map<string, Buffer>();
    await extractZipFiles(
      path,
      new Map([
        ["root/bin/ffmpeg.exe", join(directory, "out/ffmpeg.exe")],
        ["root/LICENSE.txt", join(directory, "out/LICENSE.txt")],
      ]),
      async (destination, data) => void written.set(destination, data),
    );
    assert.deepEqual(written.get(join(directory, "out/ffmpeg.exe")), exe);
    assert.equal(
      written.get(join(directory, "out/LICENSE.txt"))?.toString(),
      "licence",
    );
    await assert.rejects(
      extractZipFiles(
        path,
        new Map([["root/link", join(directory, "l")]]),
        async () => undefined,
      ),
      ArchiveError,
    );
    await assert.rejects(
      extractZipFiles(
        path,
        new Map([["../escape.txt", join(directory, "e")]]),
        async () => undefined,
      ),
      ArchiveError,
    );
    await assert.rejects(
      extractZipFiles(
        path,
        new Map([["root/missing", join(directory, "m")]]),
        async () => undefined,
      ),
      /Missing/u,
    );
    // A flipped byte fails the checksum.
    const bytes = await readFile(path);
    const corrupt = Buffer.from(bytes);
    const index = corrupt.indexOf(Buffer.from("licence"));
    corrupt[index] = corrupt[index]! ^ 0xff;
    await writeFile(join(directory, "bad.zip"), corrupt);
    await assert.rejects(
      extractZipFiles(
        join(directory, "bad.zip"),
        new Map([["root/LICENSE.txt", join(directory, "x")]]),
        async () => undefined,
      ),
      /integrity/u,
    );
    assert.equal(listZip(bytes).length, 4);
    assert.throws(() => listZip(Buffer.from("not a zip")), ArchiveError);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function tarEntry(name: string, data: Buffer, type = "0"): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, "utf8");
  header.write("0000644\0", 100);
  header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124);
  header.write(type, 156);
  header.write("ustar\0", 257);
  header.write("00", 263);
  const padding = Buffer.alloc((512 - (data.length % 512)) % 512);
  return Buffer.concat([header, data, padding]);
}

test("the tarball reader streams only the requested files and records their hashes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "win-tgz-"));
  try {
    const codex = Buffer.alloc(100_000, 7);
    const host = Buffer.from("host");
    const record = " path=package/vendor/long/host.exe\n";
    let length = record.length + 1;
    while (String(length).length + record.length !== length)
      length = String(length).length + record.length;
    const pax = Buffer.from(`${length}${record}`);
    const archive = gzipSync(
      Buffer.concat([
        tarEntry("package/package.json", Buffer.from("{}")),
        tarEntry("package/vendor/bin/codex.exe", codex),
        tarEntry("PaxHeader", pax, "x"),
        tarEntry("ignored", host),
        Buffer.alloc(1024),
      ]),
    );
    const path = join(directory, "a.tgz");
    await writeFile(path, archive);
    const found = await extractTarGzFiles(
      path,
      new Map([
        ["package/vendor/bin/codex.exe", join(directory, "out/codex.exe")],
        ["package/vendor/long/host.exe", join(directory, "out/host.exe")],
      ]),
    );
    assert.equal(found.get("package/vendor/bin/codex.exe")?.size, codex.length);
    assert.equal(
      found.get("package/vendor/bin/codex.exe")?.sha256,
      createHash("sha256").update(codex).digest("hex"),
    );
    assert.deepEqual(await readFile(join(directory, "out/codex.exe")), codex);
    assert.deepEqual(await readFile(join(directory, "out/host.exe")), host);
    await assert.rejects(
      extractTarGzFiles(
        path,
        new Map([["package/absent", join(directory, "z")]]),
      ),
      /Missing/u,
    );
    const link = gzipSync(
      Buffer.concat([
        tarEntry("package/l", Buffer.alloc(0), "2"),
        Buffer.alloc(1024),
      ]),
    );
    await writeFile(join(directory, "link.tgz"), link);
    await assert.rejects(
      extractTarGzFiles(
        join(directory, "link.tgz"),
        new Map([["package/l", join(directory, "l")]]),
      ),
      /regular file/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("archive and download helpers reject unsafe names and wrong integrity", () => {
  for (const bad of ["../x", "a/../b", "/abs", "C:/x", "a\\b", "", "a\0b"])
    assert.equal(isSafeArchivePath(bad), false, bad);
  assert.equal(isSafeArchivePath("package/vendor/bin/codex.exe"), true);
  const digest = createHash("sha512").update("x").digest("base64");
  assert.equal(integrityMatches(`sha512-${digest}`, digest), true);
  assert.equal(integrityMatches("sha1-abc", digest), false);
  assert.equal(integrityMatches(`sha512-${digest}`, "other"), false);
});

test("staged Windows dependencies must match the root lockfile and drop other platforms", async () => {
  const lock = {
    packages: {
      "": {},
      "node_modules/sharp": { version: "0.35.5", integrity: "sha512-a" },
      "node_modules/@img/sharp-win32-x64": {
        version: "0.35.5",
        integrity: "sha512-b",
      },
    },
  };
  assert.deepEqual(
    unpinnedPackages(
      {
        packages: {
          "node_modules/sharp": { version: "0.35.5", integrity: "sha512-a" },
          "node_modules/@img/sharp-win32-x64": {
            version: "0.35.5",
            integrity: "sha512-b",
          },
        },
      },
      lock,
    ),
    [],
  );
  const problems = unpinnedPackages(
    {
      packages: {
        "node_modules/sharp": {
          version: "0.35.5",
          integrity: "sha512-CHANGED",
        },
        "node_modules/extra": { version: "1.0.0", integrity: "sha512-c" },
        "node_modules/bare": { version: "1.0.0" },
      },
    },
    lock,
  );
  assert.equal(problems.length, 3);
  const pins = (await loadWindowsPins()).dependencies;
  assert.equal(isExcludedPath(pins, "onnxruntime-web"), true);
  assert.equal(
    isExcludedPath(pins, "onnxruntime-web/node_modules/onnxruntime-common"),
    true,
  );
  assert.equal(isExcludedPath(pins, "onnxruntime-common"), false);
  const packageRoot = join("stage", "node_modules", "onnxruntime-node");
  const inside = (relative: string) =>
    join(packageRoot, ...relative.split("/"));
  for (const keep of [
    "bin",
    "bin/napi-v6",
    "bin/napi-v6/win32",
    "bin/napi-v6/win32/x64",
    "bin/napi-v6/win32/x64/onnxruntime.dll",
    "dist/index.js",
  ])
    assert.equal(
      keepFile(pins, packageRoot, "onnxruntime-node", inside(keep)),
      true,
      keep,
    );
  for (const drop of [
    "bin/napi-v6/linux",
    "bin/napi-v6/linux/x64/onnxruntime_binding.node",
    "bin/napi-v6/darwin/arm64",
    "bin/napi-v6/win32/arm64",
    "bin/napi-v6/win32/arm64/onnxruntime.dll",
  ])
    assert.equal(
      keepFile(pins, packageRoot, "onnxruntime-node", inside(drop)),
      false,
      drop,
    );
  assert.equal(
    keepFile(pins, packageRoot, "sharp", inside("bin/napi-v6/linux")),
    true,
  );
});

test("the uninstall list removes exactly the payload, deepest folders last-created first", async () => {
  const directory = await mkdtemp(join(tmpdir(), "win-payload-"));
  try {
    await mkdir(join(directory, "resources/ffmpeg"), { recursive: true });
    await writeFile(join(directory, "ai-video-editor.exe"), "exe");
    await writeFile(join(directory, "resources/app.asar"), "asar");
    await writeFile(join(directory, "resources/ffmpeg/ffmpeg.exe"), "ff");
    const entries = await listPayload(directory);
    const script = uninstallList(entries);
    assert.match(script, /^Delete "\$INSTDIR\\ai-video-editor\.exe"\r$/mu);
    assert.match(script, /Delete "\$INSTDIR\\resources\\ffmpeg\\ffmpeg\.exe"/u);
    // Folders come after every file and nested folders before their parents.
    const lines = script.trim().split("\r\n");
    const lastDelete = lines
      .map((line) => line.startsWith("Delete"))
      .lastIndexOf(true);
    const firstRmdir = lines.findIndex((line) => line.startsWith("RMDir"));
    assert.ok(firstRmdir > lastDelete);
    assert.ok(
      lines.indexOf('RMDir "$INSTDIR\\resources\\ffmpeg"') <
        lines.indexOf('RMDir "$INSTDIR\\resources"'),
    );
    // It never mentions the user's data folder or a recursive delete.
    assert.doesNotMatch(
      script,
      /APPDATA|RMDir \/r|ai-video-editor\\(?!\.exe)/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a payload that contains a link is refused", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "win-payload-link-"));
  try {
    await writeFile(join(directory, "real.txt"), "x");
    try {
      await symlink(join(directory, "real.txt"), join(directory, "link.txt"));
    } catch {
      context.skip("symbolic links cannot be created on this host");
      return;
    }
    await assert.rejects(listPayload(directory), /contains a link/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("NSIS strings escape dollar signs and reject quotes; versions become quad form", () => {
  assert.equal(nsisPath("a/b$c/d.dll"), "a\\b$$c\\d.dll");
  assert.throws(() => nsisPath('a"b'));
  assert.throws(() => nsisPath("a\nb"));
  assert.equal(versionQuad("0.0.1"), "0.0.1.0");
  assert.equal(versionQuad("1.2.3-beta.1"), "1.2.3.0");
  assert.throws(() => versionQuad("one"));
});
