import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import {
  compositionFile,
  packageFile,
  packageMimeTypes,
} from "./composition-import.ts";

/**
 * Serves sealed compositions on the `composition` host of the app scheme
 * (ADR 0021): the stored page by hash, the vendored HyperFrames runtime and
 * stage bridge, and pinned npm package files (libraries, ES modules, fonts,
 * models) from a local cache. A file missing from the cache is fetched once
 * from jsDelivr by its exact pinned path; nothing else ever reaches the
 * network, and a composition itself has no network at all.
 */

/**
 * What a sealed composition page may do. It runs in a sandboxed frame with
 * an opaque origin; scripts (including ES modules and WebAssembly) come from
 * this host or are inline, and it may fetch only this host's pinned files
 * (for example a model or a wasm file of a package) and data or blob URLs.
 */
export function compositionPolicy(scheme: string): string {
  return [
    "default-src 'none'",
    `script-src ${scheme}://composition 'unsafe-inline' 'wasm-unsafe-eval'`,
    "style-src 'unsafe-inline'",
    "img-src data: blob:",
    "font-src data:",
    "media-src data: blob:",
    `connect-src ${scheme}://composition data: blob:`,
    "frame-src 'none'",
    "worker-src blob:",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}

/** `/lib/<package>@<version>/<file>`; scoped packages have one more segment. */
const libraryPath = /^\/lib\/(@[^/@]+\/[^/@]+|[^/@/]+)@([^/]+)\/(.+)$/u;

export interface CompositionServerOptions {
  scheme: string;
  /** Stored compositions, by hash. */
  compositions: string;
  /** Downloaded pinned library files. */
  libraryCache: string;
  /** Packaged files: the HyperFrames runtime and the stage bridge. */
  packaged: { runtime: Buffer; bridge: Buffer };
  fetchLibrary: (url: string) => Promise<Buffer>;
}

const javascript = "text/javascript; charset=utf-8";

export async function serveComposition(
  pathname: string,
  options: CompositionServerOptions,
): Promise<Response> {
  const notFound = () => new Response("Not found", { status: 404 });
  const page = /^\/([a-f0-9]{64})\.html$/u.exec(pathname);
  if (page) {
    try {
      const html = await readFile(
        compositionFile(options.compositions, page[1]!),
      );
      return new Response(new Uint8Array(html), {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy": compositionPolicy(options.scheme),
        },
      });
    } catch {
      return notFound();
    }
  }
  if (pathname === "/lib/hyperframes-runtime.js")
    return new Response(new Uint8Array(options.packaged.runtime), {
      headers: { "Content-Type": javascript },
    });
  if (pathname === "/lib/stage-bridge.js")
    return new Response(new Uint8Array(options.packaged.bridge), {
      headers: { "Content-Type": javascript },
    });
  const library = libraryPath.exec(pathname);
  // The same validation as sealing: an exact, pinned package file.
  const pinned = library
    ? packageFile(
        `https://cdn.jsdelivr.net/npm/${library[1]}@${library[2]}/${library[3]}`,
      )
    : null;
  if (!pinned) return notFound();
  let bytes: Buffer;
  try {
    bytes = await cachedPackageFile(
      options.libraryCache,
      pinned,
      options.fetchLibrary,
    );
  } catch {
    return notFound();
  }
  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type":
        packageMimeTypes[extname(pinned.file).toLowerCase()] ??
        "application/octet-stream",
      // ES modules and fetches from the sandboxed (opaque-origin) frame are
      // cross-origin requests.
      "Access-Control-Allow-Origin": "*",
    },
  });
}

/** The most the package cache may hold; the oldest files go first. */
export const packageCacheQuotaBytes = 512 * 1024 * 1024;

const sha256 = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

/**
 * A pinned npm package file from jsDelivr: read from the local cache, or
 * fetched once by its exact URL and cached. Callers validate the name,
 * version and file first. The first download's SHA-256 is kept beside the
 * file and checked on every read, so a changed or damaged cache entry is
 * fetched again instead of being served; a file from before hashes were
 * kept is adopted as it is.
 */
export async function cachedPackageFile(
  cache: string,
  pinned: { name: string; version: string; file: string },
  fetch: (url: string) => Promise<Buffer>,
  quotaBytes = packageCacheQuotaBytes,
): Promise<Buffer> {
  const cached = join(
    cache,
    `${pinned.name.replace("/", "__")}@${pinned.version}`,
    pinned.file,
  );
  const hashed = `${cached}.sha256`;
  const store = async (bytes: Buffer) => {
    await mkdir(dirname(cached), { recursive: true, mode: 0o700 });
    for (const [target, content] of [
      [cached, bytes],
      [hashed, sha256(bytes)],
    ] as const) {
      const temporary = `${target}.${process.pid}.tmp`;
      await writeFile(temporary, content, { mode: 0o600 });
      await rename(temporary, target);
    }
  };
  try {
    const bytes = await readFile(cached);
    let expected: string | null = null;
    try {
      expected = (await readFile(hashed, "utf8")).trim();
    } catch {
      expected = null;
    }
    if (expected === null) {
      await store(bytes);
      return bytes;
    }
    if (sha256(bytes) === expected) return bytes;
  } catch {
    // Not cached.
  }
  const bytes = await fetch(
    `https://cdn.jsdelivr.net/npm/${pinned.name}@${pinned.version}/${pinned.file}`,
  );
  await store(bytes);
  await trimPackageCache(cache, quotaBytes, cached).catch(() => undefined);
  return bytes;
}

/** Deletes the oldest cached files until the cache fits its quota. */
export async function trimPackageCache(
  cache: string,
  quotaBytes: number,
  keep: string,
): Promise<void> {
  const files: { path: string; size: number; time: number }[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && !entry.name.endsWith(".sha256")) {
        const info = await stat(path);
        files.push({ path, size: info.size, time: info.mtimeMs });
      }
    }
  };
  await walk(cache);
  let total = files.reduce((sum, file) => sum + file.size, 0);
  for (const file of files.sort((a, b) => a.time - b.time)) {
    if (total <= quotaBytes) return;
    if (file.path === keep) continue;
    await rm(file.path, { force: true });
    await rm(`${file.path}.sha256`, { force: true });
    total -= file.size;
  }
}

/** Stores a sealed composition page by its hash. */
export async function storeComposition(
  root: string,
  sha256: string,
  html: string,
): Promise<void> {
  const target = compositionFile(root, sha256);
  await mkdir(root, { recursive: true, mode: 0o700 });
  try {
    await readFile(target);
    return;
  } catch {
    // Not stored yet.
  }
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, html, { mode: 0o600 });
  await rename(temporary, target);
}
