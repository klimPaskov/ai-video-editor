import { lstat, readdir, rm, unlink } from "node:fs/promises";
import { join } from "node:path";
import { mediaIdPattern } from "../../../packages/domain/src/library.ts";

/**
 * The app-owned files kept about a project outside its own folder:
 * conversations, per-project choices and export records. Sources, playback
 * proxies and transcripts belong to the media and stay with it.
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
    ],
    // One JSON delivery record per export; the exported videos stay.
    directories: [join(userData, "exports", projectId)],
  };
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
