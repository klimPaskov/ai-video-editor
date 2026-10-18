import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { compositionFile } from "./composition-import.ts";
import { compositionLibraries } from "./composition-import.ts";

/**
 * Serves sealed HyperFrames compositions on the `composition` host of the
 * app scheme (ADR 0021): the stored page by hash, the vendored HyperFrames
 * runtime and stage bridge, and pinned animation libraries from a local
 * cache. A library missing from the cache is fetched once from jsDelivr by
 * its exact pinned path; nothing else ever reaches the network.
 */

export function compositionPolicy(scheme: string): string {
  return [
    "default-src 'none'",
    `script-src ${scheme}://composition 'unsafe-inline'`,
    "style-src 'unsafe-inline'",
    "img-src data: blob:",
    "font-src data:",
    "media-src data: blob:",
    "connect-src 'none'",
    "frame-src 'none'",
    "worker-src blob:",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}

const libraryPath =
  /^\/lib\/(@?[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)?)@(\d+\.\d+\.\d+)\/([A-Za-z0-9._/-]+\.js)$/u;

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
  if (
    !library ||
    !compositionLibraries.has(library[1]!) ||
    library[3]!.split("/").some((part) => part === "." || part === "..")
  )
    return notFound();
  let bytes: Buffer;
  try {
    bytes = await cachedPackageFile(
      options.libraryCache,
      { name: library[1]!, version: library[2]!, file: library[3]! },
      options.fetchLibrary,
    );
  } catch {
    return notFound();
  }
  return new Response(new Uint8Array(bytes), {
    headers: { "Content-Type": javascript },
  });
}

/**
 * A pinned npm package file from jsDelivr: read from the local cache, or
 * fetched once by its exact URL and cached. Callers validate the name,
 * version and file first.
 */
export async function cachedPackageFile(
  cache: string,
  pinned: { name: string; version: string; file: string },
  fetch: (url: string) => Promise<Buffer>,
): Promise<Buffer> {
  const cached = join(
    cache,
    `${pinned.name.replace("/", "__")}@${pinned.version}`,
    pinned.file,
  );
  try {
    return await readFile(cached);
  } catch {
    const bytes = await fetch(
      `https://cdn.jsdelivr.net/npm/${pinned.name}@${pinned.version}/${pinned.file}`,
    );
    await mkdir(dirname(cached), { recursive: true, mode: 0o700 });
    const temporary = `${cached}.${process.pid}.tmp`;
    await writeFile(temporary, bytes, { mode: 0o600 });
    await rename(temporary, cached);
    return bytes;
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
