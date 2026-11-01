import assert from "node:assert/strict";
import { copyFile, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { extractTarGzFiles, extractZipFiles, sha256File } from "./archives.ts";
import { downloadPinned, type PinnedDownload } from "./download.ts";

export interface WindowsPins {
  schemaVersion: 1;
  electron: string;
  ffmpeg: {
    name: string;
    version: string;
    ffmpegCommit: string;
    recipeRepository: string;
    recipeCommit: string;
    release: string;
    license: string;
    archiveRoot: string;
    download: PinnedDownload;
    files: string[];
  };
  codex: {
    version: string;
    npmPackage: string;
    npmVersion: string;
    lockfileEntry: string;
    license: string;
    download: PinnedDownload & { integrity: string };
    executable: string;
    host: string;
  };
  dependencies: {
    target: string;
    exclude: string[];
    onnxruntimeKeep: string;
  };
}

export async function loadWindowsPins(): Promise<WindowsPins> {
  const pins = JSON.parse(
    await readFile(join(import.meta.dirname, "windows-release.json"), "utf8"),
  ) as WindowsPins;
  assert.equal(pins.schemaVersion, 1);
  return pins;
}

interface Lockfile {
  packages: Record<string, { version?: string; integrity?: string }>;
}

/** Pulls FFmpeg's build configuration string out of a shared libavutil. */
export function extractConfiguration(libavutil: Buffer): string {
  const start = libavutil.indexOf("--prefix=");
  assert.ok(start >= 0, "libavutil has no embedded configuration");
  const end = libavutil.indexOf(0, start);
  return libavutil.toString("latin1", start, end < 0 ? undefined : end);
}

/**
 * The release redistributes FFmpeg under the LGPL only. A configuration that
 * enables GPL or nonfree code (libx264, libx265, Xvid, fdk-aac, ...) is
 * refused outright; this is the enforcement behind docs/adr/0022.
 */
export function assertLgplConfiguration(configuration: string): void {
  const flags = new Set(configuration.split(/\s+/u));
  for (const forbidden of [
    "--enable-gpl",
    "--enable-nonfree",
    "--enable-libx264",
    "--enable-libx265",
    "--enable-libxvid",
    "--enable-libxavs2",
    "--enable-libdavs2",
    "--enable-libfdk-aac",
    "--enable-libvidstab",
    "--enable-frei0r",
    "--enable-rubberband",
    "--enable-librubberband",
    "--enable-libdvdread",
    "--enable-libdvdnav",
    "--enable-avisynth",
  ])
    assert.ok(
      !flags.has(forbidden),
      `FFmpeg configuration enables ${forbidden}, which is not LGPL-redistributable`,
    );
  assert.ok(
    flags.has("--enable-shared") && !flags.has("--enable-static"),
    "FFmpeg must be the shared (DLL) build so users can replace the libraries",
  );
  assert.ok(
    flags.has("--enable-version3"),
    "Unexpected FFmpeg configuration: expected an LGPL version 3 build",
  );
  assert.ok(
    flags.has("--target-os=mingw32") && flags.has("--arch=x86_64"),
    "FFmpeg is not a Windows x86_64 build",
  );
}

const externalLibrary =
  /^--enable-(lib[a-z0-9-]+|fontconfig|gmp|lzma|zlib|iconv|schannel|sdl2|openal|opencl|vulkan|amf|ffnvcodec|lv2|chromaprint)$/u;

/** Enabled external libraries named in a configuration, for the notice. */
export function externalLibraries(configuration: string): string[] {
  return configuration
    .split(/\s+/u)
    .filter((flag) => externalLibrary.test(flag))
    .map((flag) => flag.slice("--enable-".length))
    .sort();
}

export interface FfmpegManifest {
  schemaVersion: 1;
  name: "ffmpeg";
  version: string;
  platform: "win32";
  arch: "x64";
  license: string;
  ffmpeg: "ffmpeg.exe";
  ffprobe: "ffprobe.exe";
  files: { name: string; size: number; sha256: string }[];
}

export function ffmpegNotice(
  pins: WindowsPins["ffmpeg"],
  configuration: string,
): string {
  return [
    "FFmpeg (bundled with AI Video Editor)",
    "",
    `Version: ${pins.version} (FFmpeg commit ${pins.ffmpegCommit})`,
    `Build: ${pins.recipeRepository} release ${pins.release}, recipe commit ${pins.recipeCommit}`,
    `Licence: ${pins.license}. FFmpeg is licensed under the GNU Lesser General Public Licence (LICENSE.txt in this folder). The build contains no GPL or nonfree components and is shared (DLLs), so the FFmpeg libraries can be replaced by compatible builds.`,
    "",
    "AI Video Editor runs ffmpeg.exe and ffprobe.exe as separate programs.",
    "",
    "Corresponding source: the FFmpeg source at the commit above (https://github.com/FFmpeg/FFmpeg) and the build recipe at the recipe commit above, which pins every external library with its own source and licence.",
    "",
    "External libraries compiled into the DLLs, each under its own licence:",
    ...externalLibraries(configuration).map((name) => `  - ${name}`),
    "",
    "Configuration:",
    configuration,
    "",
  ].join("\n");
}

async function writeVerified(path: string, data: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, data, { mode: 0o644 });
}

/** Downloads, verifies and lays out the pinned Windows FFmpeg. */
export async function provisionFfmpeg(
  pins: WindowsPins["ffmpeg"],
  cacheDirectory: string,
  outputDirectory: string,
): Promise<FfmpegManifest> {
  const zipPath = await downloadPinned(
    pins.download,
    cacheDirectory,
    `ffmpeg-${pins.version}-win64-lgpl-shared.zip`,
  );
  await mkdir(outputDirectory, { recursive: true });
  const wanted = new Map<string, string>();
  for (const file of pins.files)
    wanted.set(
      `${pins.archiveRoot}/${file}`,
      join(outputDirectory, basename(file)),
    );
  await extractZipFiles(zipPath, wanted, writeVerified);
  const configuration = extractConfiguration(
    await readFile(join(outputDirectory, "avutil-60.dll")),
  );
  assertLgplConfiguration(configuration);
  await writeFile(
    join(outputDirectory, "NOTICE.txt"),
    ffmpegNotice(pins, configuration),
  );
  const names = [...pins.files.map((file) => basename(file)), "NOTICE.txt"];
  const files: FfmpegManifest["files"] = [];
  for (const name of names) {
    const path = join(outputDirectory, name);
    const info = await lstat(path);
    assert.ok(info.isFile() && !info.isSymbolicLink() && info.size > 0);
    files.push({ name, size: info.size, sha256: await sha256File(path) });
  }
  const manifest: FfmpegManifest = {
    schemaVersion: 1,
    name: "ffmpeg",
    version: pins.version,
    platform: "win32",
    arch: "x64",
    license: pins.license,
    ffmpeg: "ffmpeg.exe",
    ffprobe: "ffprobe.exe",
    files,
  };
  await writeFile(
    join(outputDirectory, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
  return manifest;
}

export interface CodexManifest {
  schemaVersion: 2;
  version: string;
  platform: "win32";
  arch: "x64";
  executable: "codex.exe";
  size: number;
  sha256: string;
  hostExecutable: "codex-code-mode-host.exe";
  hostSize: number;
  hostSha256: string;
  licenseSha256: string;
}

/** Lockfile authority: the pinned tarball must be the one package-lock.json names. */
export function assertCodexLockEntry(
  pins: WindowsPins["codex"],
  lock: Lockfile,
): void {
  const entry = lock.packages[pins.lockfileEntry];
  assert.ok(entry, "package-lock.json has no Windows Codex entry");
  assert.equal(entry.version, pins.npmVersion);
  assert.equal(entry.integrity, pins.download.integrity);
}

/**
 * Lays out the Windows Codex client exactly as packages/codex-bridge's resolver
 * expects (codex.exe, codex-code-mode-host.exe, licence, manifest). Only these
 * two executables ship; the shell sandbox helpers and ripgrep that the npm
 * package also contains belong to command execution, which the editor turns
 * off for Codex.
 */
export async function provisionCodex(
  pins: WindowsPins["codex"],
  root: string,
  cacheDirectory: string,
  outputDirectory: string,
): Promise<CodexManifest> {
  assertCodexLockEntry(
    pins,
    JSON.parse(await readFile(join(root, "package-lock.json"), "utf8")),
  );
  const tarball = await downloadPinned(
    pins.download,
    cacheDirectory,
    `codex-${pins.npmVersion}.tgz`,
  );
  await mkdir(outputDirectory, { recursive: true });
  const executable = join(outputDirectory, "codex.exe");
  const host = join(outputDirectory, "codex-code-mode-host.exe");
  const extracted = await extractTarGzFiles(
    tarball,
    new Map([
      [pins.executable, executable],
      [pins.host, host],
    ]),
  );
  const license = join(outputDirectory, "LICENSE-APACHE-2.0.txt");
  await copyFile(join(root, "licenses/CODEX-APACHE-2.0.txt"), license);
  await copyFile(
    join(root, "licenses/CODEX-NOTICE.txt"),
    join(outputDirectory, "NOTICE.txt"),
  );
  const main = extracted.get(pins.executable);
  const hostFile = extracted.get(pins.host);
  assert.ok(main && hostFile);
  const manifest: CodexManifest = {
    schemaVersion: 2,
    version: pins.version,
    platform: "win32",
    arch: "x64",
    executable: "codex.exe",
    size: main.size,
    sha256: main.sha256,
    hostExecutable: "codex-code-mode-host.exe",
    hostSize: hostFile.size,
    hostSha256: hostFile.sha256,
    licenseSha256: await sha256File(license),
  };
  await writeFile(
    join(outputDirectory, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
  return manifest;
}
