import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, posix, sep } from "node:path";
import type { WindowsPins } from "./sidecars.ts";

/**
 * The Windows app needs the Windows builds of the native packages
 * (onnxruntime-node and sharp), which `npm ci` on Linux does not install.
 * They are installed into a separate staging tree with --os/--cpu, and every
 * installed package must carry exactly the version and integrity the root
 * package-lock.json already pins.
 */

interface LockEntry {
  version?: string;
  resolved?: string;
  integrity?: string;
  link?: boolean;
}
interface Lock {
  packages: Record<string, LockEntry>;
}

function packageName(lockKey: string): string {
  const index = lockKey.lastIndexOf("node_modules/");
  return index < 0 ? "" : lockKey.slice(index + "node_modules/".length);
}

/** Returns a description of every staged package the root lockfile does not pin. */
export function unpinnedPackages(staged: Lock, root: Lock): string[] {
  const pinned = new Map<string, string>();
  for (const [key, entry] of Object.entries(root.packages)) {
    const name = packageName(key);
    if (name && entry.version && entry.integrity)
      pinned.set(`${name}@${entry.version}`, entry.integrity);
  }
  const problems: string[] = [];
  for (const [key, entry] of Object.entries(staged.packages)) {
    const name = packageName(key);
    if (!name) continue;
    if (entry.link) continue;
    const id = `${name}@${entry.version}`;
    if (!entry.integrity) problems.push(`${id} has no integrity`);
    else if (pinned.get(id) !== entry.integrity)
      problems.push(`${id} is not pinned by package-lock.json`);
  }
  return problems.sort();
}

/**
 * True for a package directory (a path under node_modules, "/"-separated)
 * that must not ship in the Windows app, including anything nested in it.
 */
export function isExcludedPath(
  pins: WindowsPins["dependencies"],
  path: string,
): boolean {
  return pins.exclude.some(
    (name) => path === name || path.startsWith(`${name}/`),
  );
}

/**
 * Keeps only the Windows x64 binary of onnxruntime-node (the npm package holds
 * every platform: roughly 480 MB of other-OS binaries and CPUs).
 */
export function keepFile(
  pins: WindowsPins["dependencies"],
  packageRoot: string,
  name: string,
  file: string,
): boolean {
  if (name !== "onnxruntime-node") return true;
  const relative = file
    .slice(packageRoot.length)
    .split(sep)
    .filter(Boolean)
    .join(posix.sep);
  if (!relative.startsWith("bin/napi-v6/")) return true;
  const keep = pins.onnxruntimeKeep;
  return (
    relative === "bin/napi-v6" ||
    relative.startsWith(`${keep}/`) ||
    keep.startsWith(`${relative}/`) ||
    relative === keep
  );
}

/** Installs the production dependencies for win32-x64 into `stageDirectory`. */
export async function stageWindowsDependencies(
  root: string,
  stageDirectory: string,
): Promise<void> {
  const rootPackage = JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  ) as { dependencies?: Record<string, string> };
  assert.ok(rootPackage.dependencies, "No production dependencies to stage");
  await mkdir(stageDirectory, { recursive: true });
  await writeFile(
    join(stageDirectory, "package.json"),
    JSON.stringify({
      name: "ai-video-editor-windows-dependencies",
      version: "0.0.0",
      private: true,
      dependencies: rootPackage.dependencies,
    }),
  );
  execFileSync(
    process.platform === "win32" ? "npm.cmd" : "npm",
    [
      "install",
      "--omit=dev",
      "--os=win32",
      "--cpu=x64",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--loglevel=error",
    ],
    {
      cwd: stageDirectory,
      stdio: "inherit",
      shell: process.platform === "win32",
    },
  );
  const staged = JSON.parse(
    await readFile(
      join(stageDirectory, "node_modules/.package-lock.json"),
      "utf8",
    ),
  ) as Lock;
  const rootLock = JSON.parse(
    await readFile(join(root, "package-lock.json"), "utf8"),
  ) as Lock;
  const problems = unpinnedPackages(staged, rootLock);
  assert.deepEqual(
    problems,
    [],
    `Windows dependencies differ from package-lock.json:\n${problems.join("\n")}`,
  );
}
