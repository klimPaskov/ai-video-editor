import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";

/**
 * The packaged FFmpeg/ffprobe pair. Windows installers ship a pinned shared
 * LGPL build under resources/ffmpeg together with a manifest written by
 * scripts/build_desktop.mjs; this module verifies it before anything runs it.
 * Builds without that folder (the Linux test guest and developer machines)
 * use the FFmpeg on PATH, exactly as before.
 */
export type MediaToolsSource = "bundled" | "system";

export interface MediaTools {
  ffmpeg: string;
  ffprobe: string;
  /** Folder holding the bundled executables and libraries, or null. */
  directory: string | null;
  source: MediaToolsSource;
}

export const mediaToolsMissingMessage =
  "The video tools that come with Urushi are missing or damaged. Reinstall the app to repair them.";

export class MediaToolsError extends Error {
  constructor() {
    super(mediaToolsMissingMessage);
    this.name = "MediaToolsError";
  }
}

interface ManifestFile {
  name: string;
  size: number;
  sha256: string;
}

const maxManifestBytes = 16_384;
const maxFiles = 32;

async function digest(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function parseManifest(
  text: string,
  platform: NodeJS.Platform,
  arch: string,
): { files: ManifestFile[]; executables: [string, string] } {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new MediaToolsError();
  const record = value as Record<string, unknown>;
  const keys = [
    "schemaVersion",
    "name",
    "version",
    "platform",
    "arch",
    "license",
    "ffmpeg",
    "ffprobe",
    "files",
  ];
  if (
    Object.keys(record).length !== keys.length ||
    keys.some((key) => !(key in record)) ||
    record.schemaVersion !== 1 ||
    record.name !== "ffmpeg" ||
    typeof record.version !== "string" ||
    record.platform !== platform ||
    record.arch !== arch ||
    typeof record.license !== "string" ||
    typeof record.ffmpeg !== "string" ||
    typeof record.ffprobe !== "string" ||
    !Array.isArray(record.files) ||
    record.files.length === 0 ||
    record.files.length > maxFiles
  )
    throw new MediaToolsError();
  const names = new Set<string>();
  const files = record.files.map((entry: unknown): ManifestFile => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      throw new MediaToolsError();
    const file = entry as Record<string, unknown>;
    if (
      Object.keys(file).length !== 3 ||
      typeof file.name !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(file.name) ||
      names.has(file.name) ||
      typeof file.size !== "number" ||
      !Number.isSafeInteger(file.size) ||
      file.size <= 0 ||
      typeof file.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(file.sha256)
    )
      throw new MediaToolsError();
    names.add(file.name);
    return { name: file.name, size: file.size, sha256: file.sha256 };
  });
  if (
    !names.has(record.ffmpeg) ||
    !names.has(record.ffprobe) ||
    !names.has("LICENSE.txt")
  )
    throw new MediaToolsError();
  return { files, executables: [record.ffmpeg, record.ffprobe] };
}

/**
 * Main supplies Electron's resourcesPath. There is no environment or renderer
 * override. A resources/ffmpeg folder must verify completely; it is never
 * half-used. Only when the folder is absent on a non-Windows platform does the
 * system FFmpeg apply. On Windows a missing folder is an error: the release
 * never relies on whatever FFmpeg happens to be on a user's PATH.
 */
export async function resolveMediaTools(
  resourcesPath: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): Promise<MediaTools> {
  try {
    if (!isAbsolute(resourcesPath) || resourcesPath.includes("\0"))
      throw new MediaToolsError();
    const resources = await realpath(resourcesPath);
    const directory = join(resources, "ffmpeg");
    const directoryInfo = await lstat(directory).catch((error: unknown) => {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      )
        return null;
      throw error;
    });
    if (directoryInfo === null) {
      if (platform === "win32") throw new MediaToolsError();
      return {
        ffmpeg: "ffmpeg",
        ffprobe: "ffprobe",
        directory: null,
        source: "system",
      };
    }
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink())
      throw new MediaToolsError();
    const manifestPath = join(directory, "manifest.json");
    const manifestInfo = await lstat(manifestPath);
    if (
      !manifestInfo.isFile() ||
      manifestInfo.isSymbolicLink() ||
      manifestInfo.size > maxManifestBytes
    )
      throw new MediaToolsError();
    const { files, executables } = parseManifest(
      await readFile(manifestPath, "utf8"),
      platform,
      arch,
    );
    await Promise.all(
      files.map(async (file) => {
        const path = join(directory, file.name);
        const info = await lstat(path);
        if (
          !info.isFile() ||
          info.isSymbolicLink() ||
          info.size !== file.size ||
          (await digest(path)) !== file.sha256
        )
          throw new MediaToolsError();
      }),
    );
    return {
      ffmpeg: join(directory, executables[0]),
      ffprobe: join(directory, executables[1]),
      directory,
      source: "bundled",
    };
  } catch {
    throw new MediaToolsError();
  }
}

/**
 * Child processes that look FFmpeg up by name (the capture supervisor,
 * transcription audio preparation, graphics rendering) find the verified copy
 * first. Returns the environment value to assign.
 */
export function pathWithMediaTools(
  tools: MediaTools,
  currentPath: string | undefined,
): string | undefined {
  if (tools.directory === null) return currentPath;
  return currentPath
    ? `${tools.directory}${delimiter}${currentPath}`
    : tools.directory;
}
