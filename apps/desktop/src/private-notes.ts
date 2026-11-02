import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Private diagnostics and cleanup (never shown to the renderer): technical
 * failure notes with personal paths removed, and the temporary folders an
 * interrupted export or picture render can leave behind.
 */

/** Replaces the home folder and app data folder in a note with short names. */
export function redactPaths(
  text: string,
  roots: { path: string; as: string }[] = [],
): string {
  const known = [...roots, { path: homedir(), as: "~" }]
    .filter((root) => root.path.length > 3)
    .sort((a, b) => b.path.length - a.path.length);
  let result = text;
  for (const root of known) {
    // Both separator styles, as Windows paths appear either way in output.
    for (const form of new Set([
      root.path,
      root.path.replaceAll("\\", "/"),
      root.path.replaceAll("/", "\\"),
    ]))
      result = result.split(form).join(root.as);
  }
  return result;
}

/** `redactPaths` applied to every string inside a plain value. */
export function redactStrings(
  value: unknown,
  roots: { path: string; as: string }[] = [],
): unknown {
  if (typeof value === "string") return redactPaths(value, roots);
  if (Array.isArray(value))
    return value.map((item) => redactStrings(item, roots));
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        redactStrings(item, roots),
      ]),
    );
  return value;
}

const temporaryFolder =
  /^ai-video-editor-(?:graphics|frames|check)-[A-Za-z0-9]+$/u;
const partialExport =
  /^\..+\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.partial$/u;

async function removeOld(
  parent: string,
  matches: (name: string) => boolean,
  maxAgeMs: number,
  now: number,
): Promise<number> {
  let removed = 0;
  let names: string[];
  try {
    names = await readdir(parent);
  } catch {
    return 0;
  }
  for (const name of names) {
    if (!matches(name)) continue;
    const path = join(parent, name);
    try {
      const info = await lstat(path);
      // Only real folders of ours that nothing has touched for a while.
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        now - info.mtimeMs < maxAgeMs
      )
        continue;
      await rm(path, { recursive: true, force: true });
      removed++;
    } catch {
      // Left for the next start.
    }
  }
  return removed;
}

/** Removes picture, graphics and check scratch folders left by a crash. */
export function sweepTemporaryFolders(
  tempRoot = tmpdir(),
  maxAgeMs = 10 * 60_000,
  now = Date.now(),
): Promise<number> {
  return removeOld(
    tempRoot,
    (name) => temporaryFolder.test(name),
    maxAgeMs,
    now,
  );
}

const destinationsFile = "destinations.json";
const maxDestinations = 50;

/** Remembers a folder an export wrote into, so a crashed export can be swept. */
export async function recordExportFolder(
  recordRoot: string,
  folder: string,
): Promise<void> {
  let known: string[] = [];
  try {
    const parsed: unknown = JSON.parse(
      await readFile(join(recordRoot, destinationsFile), "utf8"),
    );
    if (Array.isArray(parsed))
      known = parsed.filter((item): item is string => typeof item === "string");
  } catch {
    known = [];
  }
  const next = [folder, ...known.filter((item) => item !== folder)].slice(
    0,
    maxDestinations,
  );
  await mkdir(recordRoot, { recursive: true, mode: 0o700 });
  await writeFile(join(recordRoot, destinationsFile), JSON.stringify(next), {
    mode: 0o600,
  });
}

/**
 * Removes the `.<name>.<id>.partial` staging folders of exports that never
 * finished (the app was stopped or crashed) from the folders exports used.
 */
export async function sweepPartialExports(
  recordRoot: string,
  maxAgeMs = 10 * 60_000,
  now = Date.now(),
): Promise<number> {
  let folders: string[] = [];
  try {
    const parsed: unknown = JSON.parse(
      await readFile(join(recordRoot, destinationsFile), "utf8"),
    );
    if (Array.isArray(parsed))
      folders = parsed.filter(
        (item): item is string => typeof item === "string",
      );
  } catch {
    return 0;
  }
  let removed = 0;
  for (const folder of folders)
    removed += await removeOld(
      folder,
      (name) => partialExport.test(name),
      maxAgeMs,
      now,
    );
  return removed;
}
