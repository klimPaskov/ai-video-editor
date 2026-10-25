import { lstat, readdir, rm, unlink } from "node:fs/promises";
import { join } from "node:path";
import { mediaIdPattern } from "../../../packages/domain/src/library.ts";

/**
 * The app-owned files kept about a project outside its own folder:
 * conversations, per-project choices and export records. Sources, playback
 * proxies and transcripts belong to the media and stay with it.
 *
 * Claude also keeps a workspace per project (the edit as spoken, the
 * timeline, its notes and compositions) and Claude Code keeps session logs
 * for it, which hold transcript text and pictures of the footage; both go
 * with the project (see `removeClaudeProjectData`).
 */
export function projectSideFiles(userData: string, projectId: string) {
  if (!mediaIdPattern.test(projectId)) throw new Error("Invalid project.");
  return {
    files: [
      join(userData, "claude", "threads", `${projectId}.json`),
      ...["deepseek", "gemini", "openai"].map((provider) =>
        join(userData, "api-provider-threads", `${projectId}.${provider}.json`),
      ),
      join(userData, "caption-settings", `${projectId}.json`),
      join(userData, "audio-settings", `${projectId}.json`),
      join(userData, "short-clips", `${projectId}.json`),
      // Which camera video goes with the project (the video itself stays).
      join(userData, "camera-links", `${projectId}.json`),
    ],
    // One JSON delivery record per export; the exported videos stay.
    directories: [join(userData, "exports", projectId)],
  };
}

/** Recursively removes a directory that is a real folder (never a link). */
async function removeFolder(directory: string): Promise<void> {
  try {
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("Unexpected project folder.");
    // Removing a tree removes links inside it, never what they point to.
    await rm(directory, { recursive: true });
  } catch (error) {
    if (!missing(error)) throw error;
  }
}

/**
 * Removes what Claude keeps for a project: its workspace and the Claude
 * Code session logs of that workspace. Claude Code names a session folder
 * after the workspace path with every non-alphanumeric character replaced by
 * a dash, so the folder ends with `-workspaces-<project id>`.
 */
export async function removeClaudeProjectData(
  userData: string,
  projectId: string,
): Promise<void> {
  if (!mediaIdPattern.test(projectId)) throw new Error("Invalid project.");
  await removeFolder(join(userData, "claude", "workspaces", projectId));
  const sessions = join(userData, "claude", "claude-code", "projects");
  let names: string[] = [];
  try {
    names = await readdir(sessions);
  } catch (error) {
    if (!missing(error)) throw error;
  }
  for (const name of names)
    if (name.endsWith(`-workspaces-${projectId}`))
      await removeFolder(join(sessions, name));
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

/** Removes a project's side files; anything unexpected stops the removal. */
export async function removeProjectSideFiles(
  userData: string,
  projectId: string,
): Promise<void> {
  const { files, directories } = projectSideFiles(userData, projectId);
  await removeClaudeProjectData(userData, projectId);
  for (const file of files) {
    try {
      const stat = await lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink())
        throw new Error("Unexpected project file.");
      await unlink(file);
    } catch (error) {
      if (!missing(error)) throw error;
    }
  }
  for (const directory of directories) {
    try {
      const stat = await lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error("Unexpected project folder.");
      for (const entry of await readdir(directory, { withFileTypes: true }))
        if (!entry.isFile() || !entry.name.endsWith(".json"))
          throw new Error("Unexpected project file.");
      await rm(directory, { recursive: true });
    } catch (error) {
      if (!missing(error)) throw error;
    }
  }
}
