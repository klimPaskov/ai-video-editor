import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

const VERSION = "0.155.1";

export class CodexRuntimeError extends Error {
  constructor() {
    super(
      "Codex is not installed with this copy, or it is damaged. Run the installer again and tick “Codex connection”, or use Claude.",
    );
    this.name = "CodexRuntimeError";
  }
}

async function digest(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

/** Main supplies Electron's resourcesPath. No environment or renderer override. */
export async function resolveCodexRuntime(
  resourcesPath: string,
): Promise<string> {
  try {
    if (!isAbsolute(resourcesPath) || resourcesPath.includes("\0"))
      throw new Error();
    if (
      !["linux", "win32"].includes(process.platform) ||
      process.arch !== "x64"
    )
      throw new Error();
    const resources = await realpath(resourcesPath);
    const directory = join(resources, "codex");
    const directoryInfo = await lstat(directory);
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink())
      throw new Error();
    const executableName = process.platform === "win32" ? "codex.exe" : "codex";
    const executable = join(directory, executableName);
    const hostName =
      process.platform === "win32"
        ? "codex-code-mode-host.exe"
        : "codex-code-mode-host";
    const host = join(directory, hostName);
    const license = join(directory, "LICENSE-APACHE-2.0.txt");
    const manifestPath = join(directory, "manifest.json");
    for (const path of [executable, host, license, manifestPath]) {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size === 0)
        throw new Error();
    }
    if ((await lstat(manifestPath)).size > 4096) throw new Error();
    const manifest: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest))
      throw new Error();
    const record = manifest as Record<string, unknown>;
    const keys = [
      "schemaVersion",
      "version",
      "platform",
      "arch",
      "executable",
      "size",
      "sha256",
      "hostExecutable",
      "hostSize",
      "hostSha256",
      "licenseSha256",
    ];
    if (
      Object.keys(record).length !== keys.length ||
      keys.some((key) => !(key in record))
    )
      throw new Error();
    if (
      record.schemaVersion !== 2 ||
      record.version !== VERSION ||
      record.platform !== process.platform ||
      record.arch !== process.arch ||
      record.executable !== executableName ||
      record.size !== (await lstat(executable)).size ||
      record.hostExecutable !== hostName ||
      record.hostSize !== (await lstat(host)).size ||
      typeof record.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(record.sha256) ||
      typeof record.hostSha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(record.hostSha256) ||
      typeof record.licenseSha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(record.licenseSha256)
    )
      throw new Error();
    if (
      (await digest(executable)) !== record.sha256 ||
      (await digest(host)) !== record.hostSha256 ||
      (await digest(license)) !== record.licenseSha256
    )
      throw new Error();
    if (
      process.platform === "linux" &&
      (((await lstat(executable)).mode & 0o111) === 0 ||
        ((await lstat(host)).mode & 0o111) === 0)
    )
      throw new Error();
    return executable;
  } catch {
    throw new CodexRuntimeError();
  }
}
