import { createHash, randomUUID } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, relative } from "node:path";

/**
 * The user's own Claude Code skills, offered to the app's Claude (ADR 0021).
 * The app runs Claude Code with a dedicated profile, so it mirrors the
 * skills folder of the user's normal profile into an app-owned plugin that
 * each turn loads with --plugin-dir. Only regular files are copied; links
 * are never followed. The mirror stays in the app's private data.
 */

const pluginName = "my-skills";
const maxFiles = 5_000;
const maxFileBytes = 20 * 1024 * 1024;
const maxTotalBytes = 200 * 1024 * 1024;

/** The skills folder of the user's normal Claude Code profile. */
export function userSkillsDirectory(
  env: NodeJS.ProcessEnv,
  home: string,
): string {
  const config = env.CLAUDE_CONFIG_DIR?.trim();
  return join(config ? config : join(home, ".claude"), "skills");
}

interface Entry {
  path: string;
  size: number;
  mtimeMs: number;
}

/** Folders that are never mirrored: version control and installed packages. */
const skippedFolders = new Set([".git", "node_modules", "__pycache__"]);

/**
 * Files that look like secrets (environment files, keys, tokens,
 * credentials) are never copied into the app's data, even when a skill
 * folder happens to hold one. Skills need only their instructions, scripts
 * and reference files.
 */
export function looksSecret(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    /^\.env(\.|$)/u.test(lower) ||
    /^(\.npmrc|\.netrc|\.pypirc|\.git-credentials|id_rsa|id_ed25519|id_ecdsa|id_dsa)/u.test(
      lower,
    ) ||
    /\.(pem|key|p12|pfx|jks|keystore|token|secret|secrets|kdbx|crt)$/u.test(
      lower,
    ) ||
    /(secret|credential|password|private[-_]?key|api[-_]?key)/u.test(lower)
  );
}

/** Regular files under `root`, without following links; null if over limits. */
async function listFiles(root: string): Promise<Entry[] | null> {
  const files: Entry[] = [];
  let total = 0;
  const walk = async (directory: string): Promise<boolean> => {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, item.name);
      if (item.isSymbolicLink()) continue;
      if (item.isDirectory()) {
        if (skippedFolders.has(item.name)) continue;
        if (!(await walk(path))) return false;
        continue;
      }
      if (!item.isFile() || looksSecret(item.name)) continue;
      const stat = await lstat(path);
      if (stat.size > maxFileBytes) continue;
      total += stat.size;
      files.push({ path, size: stat.size, mtimeMs: stat.mtimeMs });
      if (files.length > maxFiles || total > maxTotalBytes) return false;
    }
    return true;
  };
  return (await walk(root)) ? files : null;
}

/**
 * Brings the plugin mirror up to date and returns its directory with the
 * mirrored skill names, or null when the user has no skills.
 */
export async function mirrorUserSkills(
  source: string,
  target: string,
): Promise<{ directory: string; skills: string[] } | null> {
  let names: string[];
  try {
    const items = await readdir(source, { withFileTypes: true });
    names = [];
    for (const item of items)
      if (
        item.isDirectory() &&
        !item.isSymbolicLink() &&
        /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(item.name)
      ) {
        try {
          if ((await lstat(join(source, item.name, "SKILL.md"))).isFile())
            names.push(item.name);
        } catch {
          // A folder without SKILL.md is not a skill.
        }
      }
  } catch {
    return null;
  }
  names.sort();
  if (!names.length) return null;
  const files: Entry[] = [];
  for (const name of names) {
    const listed = await listFiles(join(source, name));
    if (!listed) continue;
    files.push(...listed);
    if (files.length > maxFiles) return null;
  }
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify(
        files.map((file) => [
          relative(source, file.path),
          file.size,
          file.mtimeMs,
        ]),
      ),
    )
    .digest("hex");
  const stamp = join(target, ".fingerprint");
  try {
    if ((await readFile(stamp, "utf8")) === fingerprint)
      return { directory: target, skills: names };
  } catch {
    // No mirror yet.
  }
  const staging = `${target}.${randomUUID()}.tmp`;
  try {
    await mkdir(join(staging, ".claude-plugin"), {
      recursive: true,
      mode: 0o700,
    });
    await writeFile(
      join(staging, ".claude-plugin", "plugin.json"),
      JSON.stringify({
        name: pluginName,
        version: "1.0.0",
        description: "The user's own Claude Code skills.",
      }),
      { mode: 0o600 },
    );
    for (const file of files) {
      const destination = join(staging, "skills", relative(source, file.path));
      await mkdir(join(destination, ".."), { recursive: true, mode: 0o700 });
      await copyFile(file.path, destination);
    }
    await writeFile(join(staging, ".fingerprint"), fingerprint, {
      mode: 0o600,
    });
    await rm(target, { recursive: true, force: true });
    await rename(staging, target);
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  return { directory: target, skills: names };
}
