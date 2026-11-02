import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { sha256File } from "./archives.ts";

/**
 * Fetches one pinned build input. The bytes must match the pinned size and
 * SHA-256 (and, for npm tarballs, the lockfile's SHA-512 integrity); nothing
 * unverified is kept, and a cached file is reused only after the same check.
 */

export interface PinnedDownload {
  url: string;
  size: number;
  sha256: string;
  /** Subresource-integrity string, for example `sha512-...`. */
  integrity?: string;
}

const allowedHosts = new Set([
  "github.com",
  "registry.npmjs.org",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
]);

export class DownloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DownloadError";
  }
}

function assertAllowed(url: string): void {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || !allowedHosts.has(parsed.hostname))
    throw new DownloadError(`Download host is not allowed: ${parsed.hostname}`);
}

export function integrityMatches(
  integrity: string,
  sha512Base64: string,
): boolean {
  const match = /^sha512-([A-Za-z0-9+/]+={0,2})$/u.exec(integrity);
  return match !== null && match[1] === sha512Base64;
}

async function verify(path: string, pin: PinnedDownload): Promise<boolean> {
  const info = await stat(path).catch(() => null);
  if (!info?.isFile() || info.size !== pin.size) return false;
  if ((await sha256File(path)) !== pin.sha256) return false;
  return true;
}

export async function downloadPinned(
  pin: PinnedDownload,
  cacheDirectory: string,
  fileName: string,
): Promise<string> {
  assertAllowed(pin.url);
  if (!/^[A-Za-z0-9._-]+$/u.test(fileName))
    throw new DownloadError("Unsafe cache file name");
  const target = join(cacheDirectory, fileName);
  await mkdir(dirname(target), { recursive: true });
  if (await verify(target, pin)) return target;
  await rm(target, { force: true });
  const partial = `${target}.partial`;
  await rm(partial, { force: true });
  const response = await fetch(pin.url, { redirect: "follow" });
  if (!response.ok || !response.body)
    throw new DownloadError(`Download failed with status ${response.status}`);
  assertAllowed(response.url || pin.url);
  const sha256 = createHash("sha256");
  const sha512 = createHash("sha512");
  let received = 0;
  try {
    await pipeline(
      Readable.fromWeb(response.body as never),
      async function* (source: AsyncIterable<Buffer>) {
        for await (const chunk of source) {
          received += chunk.length;
          if (received > pin.size)
            throw new DownloadError("Download is larger than its pinned size");
          sha256.update(chunk);
          sha512.update(chunk);
          yield chunk;
        }
      },
      createWriteStream(partial, { mode: 0o600 }),
    );
    if (received !== pin.size)
      throw new DownloadError("Download is smaller than its pinned size");
    if (sha256.digest("hex") !== pin.sha256)
      throw new DownloadError("Download does not match its pinned SHA-256");
    if (
      pin.integrity !== undefined &&
      !integrityMatches(pin.integrity, sha512.digest("base64"))
    )
      throw new DownloadError("Download does not match its pinned integrity");
    await rename(partial, target);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
  return target;
}
