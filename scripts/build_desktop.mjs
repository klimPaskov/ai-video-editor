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

await assertNativeTestEnvironment();
const root = resolve(import.meta.dirname, "..");
const evidence = join(root, "test-results");
await mkdir(evidence, { recursive: true });
const output = await mkdtemp(join(evidence, "desktop-build-"));
const staging = join(output, "app");
const codexVersion = "0.155.1";
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
const codexResources = join(output, "codex");
await mkdir(codexResources);
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
async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
const codexManifest = {
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
const mcpResources = join(output, "mcp");
await mkdir(mcpResources);
const mcpScript = join(mcpResources, "codex-video-edit-mcp.cjs");
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
  executable: "codex-video-edit-mcp.cjs",
  size: (await lstat(mcpScript)).size,
  sha256: await sha256(mcpScript),
};
await writeFile(
  join(mcpResources, "manifest.json"),
  JSON.stringify(mcpManifest, null, 2),
);
await mkdir(join(staging, "renderer"), { recursive: true });
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
for (const file of ["index.html", "style.css"])
  await copyFile(
    join(root, "apps/desktop/renderer", file),
    join(staging, "renderer", file),
  );
await copyFile(join(root, "LICENSE"), join(staging, "LICENSE"));
const installedPackages = execFileSync(
  "npm",
  ["ls", "--omit=dev", "--all", "--parseable"],
  { cwd: root, encoding: "utf8" },
)
  .split(/\r?\n/u)
  .filter(Boolean)
  .map((entry) => resolve(entry))
  .filter((entry) => {
    const relativePath = relative(join(root, "node_modules"), entry);
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
  "Third-party packages bundled with codex-video-edit.",
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
  const relativePath = relative(join(root, "node_modules"), sourcePath);
  const targetPath = join(stagedModules, relativePath);
  if (!copiedPackagePaths.has(relativePath)) {
    await cp(sourcePath, targetPath, {
      recursive: true,
      dereference: false,
      preserveTimestamps: false,
      filter: async (entry) => !(await lstat(entry)).isSymbolicLink(),
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
await writeFile(
  join(staging, "THIRD_PARTY_NOTICES.txt"),
  `${thirdPartyNotices.join("\n")}\n`,
);
await writeFile(
  join(staging, "package.json"),
  JSON.stringify({
    name: "codex-video-edit",
    productName: "codex-video-edit",
    version: "0.0.1",
    main: "main.cjs",
    license: "MIT",
  }),
);
const packages = await packager({
  dir: staging,
  out: join(output, "packaged"),
  name: "codex-video-edit",
  executableName: "codex-video-edit",
  platform: "linux",
  arch: "x64",
  electronVersion: "44.2.0",
  asar: { unpackDir: "node_modules" },
  extraResource: [codexResources, mcpResources],
  prune: false,
  overwrite: false,
});
await writeFile(
  join(output, "build.json"),
  JSON.stringify(
    {
      packages,
      root,
      electron: "44.2.0",
      codex: codexManifest,
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
  JSON.stringify({ output, executable: join(packages[0], "codex-video-edit") }),
);
