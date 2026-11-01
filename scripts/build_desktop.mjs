import { build } from "esbuild";
import { packager } from "@electron/packager";
import {
  chmod,
  cp,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { resolve, join, relative, sep } from "node:path";
import assert from "node:assert/strict";
import { assertNativeTestEnvironment } from "./native-test-environment.ts";
import { applyReleaseFuses } from "./fuses.ts";
import {
  loadWindowsPins,
  provisionCodex,
  provisionFfmpeg,
} from "./windows/sidecars.ts";
import {
  isExcludedPath,
  keepFile,
  stageWindowsDependencies,
} from "./windows/dependencies.ts";
import { buildInstaller } from "./windows/installer.ts";

// --platform linux (default, the native test guest) or win32 (cross-packaged
// from Linux; docs/adr/0022-windows-release.md). --release flips the Electron
// fuses and is for builds meant to be shipped. A win32 build also writes the
// NSIS installer (needs makensis; --fast-installer skips LZMA for smoke tests).
// See docs/24_INSTALLER_RELEASE.md.
function option(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}
const platform = option("--platform") ?? "linux";
assert.ok(
  ["linux", "win32"].includes(platform),
  "--platform must be linux or win32",
);
const release = process.argv.includes("--release");
const windows = platform === "win32";
const executableFile = windows ? "ai-video-editor.exe" : "ai-video-editor";

// Agents build only inside their isolated test environment. A person
// building the app on their own computer passes --local.
if (!process.argv.includes("--local")) await assertNativeTestEnvironment();
const root = resolve(import.meta.dirname, "..");
const evidence = join(root, "test-results");
await mkdir(evidence, { recursive: true });
const output = await mkdtemp(join(evidence, "desktop-build-"));
const staging = join(output, "app");
const codexVersion = "0.155.1";
const windowsPins = windows ? await loadWindowsPins() : undefined;
const downloadCache = join(evidence, "download-cache");
const codexResources = join(output, "codex");
await mkdir(codexResources);
async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
let codexManifest;
if (windowsPins) {
  codexManifest = await provisionCodex(
    windowsPins.codex,
    root,
    downloadCache,
    codexResources,
  );
  assert.equal(codexManifest.version, codexVersion);
} else {
  const codexPackage = join(root, "node_modules/@openai/codex-linux-x64");
  const codexPackageMetadata = JSON.parse(
    await readFile(join(codexPackage, "package.json"), "utf8"),
  );
  assert.equal(codexPackageMetadata.version, `${codexVersion}-linux-x64`);
  assert.equal(codexPackageMetadata.license, "Apache-2.0");
  const codexSource = join(
    codexPackage,
    "vendor/x86_64-unknown-linux-musl/bin/codex",
  );
  const codeModeHostSource = join(
    codexPackage,
    "vendor/x86_64-unknown-linux-musl/bin/codex-code-mode-host",
  );
  assert.ok((await lstat(codexSource)).isFile());
  assert.ok(!(await lstat(codexSource)).isSymbolicLink());
  assert.ok((await lstat(codeModeHostSource)).isFile());
  assert.ok(!(await lstat(codeModeHostSource)).isSymbolicLink());
  await copyFile(codexSource, join(codexResources, "codex"));
  await chmod(join(codexResources, "codex"), 0o755);
  await copyFile(
    codeModeHostSource,
    join(codexResources, "codex-code-mode-host"),
  );
  await chmod(join(codexResources, "codex-code-mode-host"), 0o755);
  await copyFile(
    join(root, "licenses/CODEX-APACHE-2.0.txt"),
    join(codexResources, "LICENSE-APACHE-2.0.txt"),
  );
  codexManifest = {
    schemaVersion: 2,
    version: codexVersion,
    platform: "linux",
    arch: "x64",
    executable: "codex",
    size: (await lstat(join(codexResources, "codex"))).size,
    sha256: await sha256(join(codexResources, "codex")),
    hostExecutable: "codex-code-mode-host",
    hostSize: (await lstat(join(codexResources, "codex-code-mode-host"))).size,
    hostSha256: await sha256(join(codexResources, "codex-code-mode-host")),
    licenseSha256: await sha256(join(codexResources, "LICENSE-APACHE-2.0.txt")),
  };
  await writeFile(
    join(codexResources, "manifest.json"),
    JSON.stringify(codexManifest, null, 2),
  );
}
const captureResources = join(output, "capture");
await mkdir(captureResources);
await build({
  entryPoints: [join(root, "packages/recorder/src/capture-supervisor.ts")],
  outfile: join(captureResources, "capture-supervisor.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
});
const mcpResources = join(output, "mcp");
await mkdir(mcpResources);
const mcpScript = join(mcpResources, "ai-video-editor-mcp.cjs");
await build({
  entryPoints: [join(root, "packages/codex-tools/src/mcp-server.ts")],
  outfile: mcpScript,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
});
const mcpManifest = {
  schemaVersion: 1,
  executable: "ai-video-editor-mcp.cjs",
  size: (await lstat(mcpScript)).size,
  sha256: await sha256(mcpScript),
};
await writeFile(
  join(mcpResources, "manifest.json"),
  JSON.stringify(mcpManifest, null, 2),
);
const ffmpegResources = join(output, "ffmpeg");
const ffmpegManifest = windowsPins
  ? await provisionFfmpeg(windowsPins.ffmpeg, downloadCache, ffmpegResources)
  : undefined;
await mkdir(join(staging, "renderer", "vendor"), { recursive: true });
await build({
  entryPoints: [join(root, "apps/desktop/src/main.ts")],
  outfile: join(staging, "main.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  external: ["electron"],
});
await build({
  entryPoints: [join(root, "apps/desktop/src/preload.ts")],
  outfile: join(staging, "preload.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  external: ["electron"],
});
await build({
  entryPoints: [join(root, "apps/desktop/src/transcription-worker.ts")],
  outfile: join(staging, "transcription-worker.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  external: ["@huggingface/transformers", "onnxruntime-node", "sharp"],
});
await build({
  entryPoints: [join(root, "apps/desktop/renderer/renderer.ts")],
  outfile: join(staging, "renderer/renderer.js"),
  bundle: true,
  platform: "browser",
  target: "chrome152",
});
await build({
  entryPoints: [join(root, "apps/desktop/renderer/stage-bridge.ts")],
  outfile: join(staging, "renderer/stage-bridge.js"),
  bundle: true,
  platform: "browser",
  target: "chrome152",
});
await build({
  entryPoints: [join(root, "apps/desktop/src/region-preload.ts")],
  outfile: join(staging, "region-preload.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  external: ["electron"],
});
await build({
  entryPoints: [join(root, "apps/desktop/renderer/region.ts")],
  outfile: join(staging, "renderer/region.js"),
  bundle: true,
  platform: "browser",
  target: "chrome152",
});
for (const file of [
  "index.html",
  "style.css",
  "region.html",
  "region.css",
  "stage.html",
  "stage.css",
  "vendor/hyperframes-runtime.js",
  "vendor/HYPERFRAMES-LICENSE",
])
  await copyFile(
    join(root, "apps/desktop/renderer", file),
    join(staging, "renderer", file),
  );
await copyFile(join(root, "LICENSE"), join(staging, "LICENSE"));
await copyFile(
  join(root, "apps/desktop/assets/icon-256.png"),
  join(staging, "icon-256.png"),
);
// The Windows app needs the Windows builds of the native packages, which
// `npm ci` on Linux does not install; they come from a pinned staging tree.
const dependencyRoot = windows ? join(output, "windows-dependencies") : root;
if (windows) await stageWindowsDependencies(root, dependencyRoot);
const installedPackages = execFileSync(
  "npm",
  ["ls", "--omit=dev", "--all", "--parseable"],
  { cwd: dependencyRoot, encoding: "utf8" },
)
  .split(/\r?\n/u)
  .filter(Boolean)
  .map((entry) => resolve(entry))
  .filter((entry) => {
    const relativePath = relative(join(dependencyRoot, "node_modules"), entry);
    return (
      relativePath !== "" &&
      relativePath !== ".." &&
      !relativePath.startsWith(`..${sep}`) &&
      !relativePath.startsWith(sep)
    );
  })
  .sort();
const stagedModules = join(staging, "node_modules");
await mkdir(stagedModules, { recursive: true });
const thirdPartyNotices = [
  "Third-party packages bundled with ai-video-editor.",
  "Each dependency retains its package license file under licenses/.",
  "",
];
const copiedPackagePaths = new Set();
const thirdPartyLicenseDirectory = join(staging, "licenses");
await mkdir(thirdPartyLicenseDirectory, { recursive: true });
for (const sourcePath of installedPackages) {
  const sourceStat = await lstat(sourcePath);
  if (sourceStat.isSymbolicLink()) continue;
  if (!sourceStat.isDirectory())
    throw new Error("A production dependency is not a regular directory");
  const relativePath = relative(
    join(dependencyRoot, "node_modules"),
    sourcePath,
  );
  const posixPath = relativePath.split(sep).join("/");
  if (windowsPins && isExcludedPath(windowsPins.dependencies, posixPath))
    continue;
  const targetPath = join(stagedModules, relativePath);
  if (!copiedPackagePaths.has(relativePath)) {
    await cp(sourcePath, targetPath, {
      recursive: true,
      dereference: false,
      preserveTimestamps: false,
      filter: async (entry) =>
        !(await lstat(entry)).isSymbolicLink() &&
        (!windowsPins ||
          keepFile(windowsPins.dependencies, sourcePath, posixPath, entry)),
    });
    copiedPackagePaths.add(relativePath);
  }
  const metadata = JSON.parse(
    await readFile(join(sourcePath, "package.json"), "utf8"),
  );
  const packageName = String(metadata.name ?? relativePath);
  const packageVersion = String(metadata.version ?? "unknown");
  const packageLicense =
    typeof metadata.license === "string"
      ? metadata.license
      : Array.isArray(metadata.licenses)
        ? metadata.licenses.map((item) => item.type).join(" OR ")
        : "Unspecified; see package metadata";
  thirdPartyNotices.push(
    `${packageName}@${packageVersion} - ${packageLicense}`,
  );
  for (const name of await readdir(sourcePath)) {
    if (!/^license(?:[._-].*)?$/iu.test(name)) continue;
    const licensePath = join(sourcePath, name);
    if (!(await lstat(licensePath)).isFile()) continue;
    const safeName = packageName.replace(/[^A-Za-z0-9._-]+/gu, "_");
    await copyFile(
      licensePath,
      join(
        thirdPartyLicenseDirectory,
        `${safeName}-${packageVersion}-${name.replace(/[^A-Za-z0-9._-]/gu, "_")}`,
      ),
    );
  }
}
thirdPartyNotices.push(
  "",
  `Codex client ${codexVersion} - Apache-2.0 (resources/codex; LICENSE-APACHE-2.0.txt and NOTICE.txt there)`,
);
if (windowsPins)
  thirdPartyNotices.push(
    `FFmpeg ${windowsPins.ffmpeg.version} (shared LGPL build, resources/ffmpeg) - ${windowsPins.ffmpeg.license}; its LICENSE.txt and NOTICE.txt list the build, source and compiled-in libraries`,
    `Electron ${windowsPins.electron} and Chromium - see LICENSE and LICENSES.chromium.html next to the executable`,
  );
await writeFile(
  join(staging, "THIRD_PARTY_NOTICES.txt"),
  `${thirdPartyNotices.join("\n")}\n`,
);
await writeFile(
  join(staging, "package.json"),
  JSON.stringify({
    name: "ai-video-editor",
    productName: "AI Video Editor",
    version: "0.0.1",
    main: "main.cjs",
    license: "MIT",
  }),
);
const packages = await packager({
  dir: staging,
  out: join(output, "packaged"),
  name: "ai-video-editor",
  executableName: "ai-video-editor",
  // The Windows exe gets the icon (resedit); other platforms ignore it.
  icon: join(root, "apps/desktop/assets/icon"),
  platform,
  arch: "x64",
  electronVersion: "44.2.0",
  asar: { unpackDir: "node_modules" },
  extraResource: [
    codexResources,
    mcpResources,
    captureResources,
    ...(windows ? [ffmpegResources] : []),
  ],
  ...(windows
    ? {
        // resedit writes these into the exe; no Wine is needed.
        appCopyright: "MIT licence; third-party notices ship with the app",
        win32metadata: {
          CompanyName: "AI Video Editor project",
          FileDescription: "AI Video Editor",
          ProductName: "AI Video Editor",
          OriginalFilename: "ai-video-editor.exe",
        },
      }
    : {}),
  prune: false,
  overwrite: false,
});
// Release builds only: the test build keeps the inspector available.
const electronBinary = join(packages[0], executableFile);
const fuses = release ? await applyReleaseFuses(electronBinary) : undefined;
let installer;
if (windows) {
  installer = await buildInstaller({
    appDirectory: packages[0],
    outputDirectory: output,
    productName: "AI Video Editor",
    version: "0.0.1",
    licenseFile: join(root, "LICENSE"),
    iconFile: join(root, "apps/desktop/assets/icon.ico"),
    makensis: process.env.MAKENSIS ?? "makensis",
    nsisDirectory: process.env.NSISDIR,
    fast: process.argv.includes("--fast-installer"),
    signCommand: process.env.AI_VIDEO_EDITOR_SIGN_COMMAND,
  });
}
await writeFile(
  join(output, "build.json"),
  JSON.stringify(
    {
      packages,
      root,
      electron: "44.2.0",
      platform,
      release,
      fuses: fuses ?? "not applied (test build)",
      codex: codexManifest,
      ffmpeg: ffmpegManifest,
      installer: installer ?? undefined,
      signing: windows
        ? "unsigned: no code-signing certificate is available"
        : "not applicable",
      mcp: mcpManifest,
      transcription: {
        package: "@huggingface/transformers",
        version: "4.3.0",
        runtime: "onnxruntime-node",
        model: "downloaded on first local transcription into app userData",
        license: "Apache-2.0",
        thirdPartyPackageCount: copiedPackagePaths.size,
      },
      scope: "native-media-bootstrap",
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify({
    output,
    executable: electronBinary,
    ...(installer ? { installer: installer.installer } : {}),
  }),
);
