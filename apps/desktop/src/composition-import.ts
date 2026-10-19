import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { extname, isAbsolute, join, normalize, relative, sep } from "node:path";

/**
 * Turns a HyperFrames composition in Claude's workspace into one
 * self-contained page the sealed stage can play (ADR 0021): local scripts,
 * styles, images and fonts are inlined; pinned animation libraries on
 * jsDelivr are served from the app's local library cache; pinned open-source
 * fonts (Fontsource packages on jsDelivr) are fetched once and inlined, so
 * the sealed page renders the same type on every machine, offline; anything
 * else on the network is refused with a reason Claude can act on. The composition
 * page's Content Security Policy enforces the same rules at render time.
 *
 * A composition is any page that can draw itself for a given time. It is
 * either a HyperFrames composition (a root with data-composition-id, played
 * by the vendored HyperFrames runtime) or free-form: any HTML, CSS, SVG,
 * canvas, WebGL, shader or script code that defines window.__seek(seconds)
 * (and window.__duration), or only CSS/Web/SMIL animations, which the stage
 * bridge seeks itself. Any pinned npm package file on jsDelivr may be used,
 * including ES modules through an import map.
 */

export class CompositionError extends Error {
  override name = "CompositionError";
}

/** File types a composition may take from a pinned npm package. */
const packageExtensions =
  "js|mjs|cjs|css|json|wasm|woff2|woff|ttf|otf|glb|gltf|bin|hdr|png|jpe?g|webp|gif|svg|txt";

const packageName =
  "(@[a-z0-9][a-z0-9._-]*\\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)";
const packageUrl = new RegExp(
  `^https://cdn\\.jsdelivr\\.net/npm/${packageName}@(\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?)/([A-Za-z0-9._/-]+\\.(?:${packageExtensions}))$`,
  "u",
);

/** An exact, pinned file of an npm package on jsDelivr, or null. */
export function packageFile(
  url: string,
): { name: string; version: string; file: string } | null {
  const match = packageUrl.exec(url);
  if (
    !match ||
    match[3]!.split("/").some((part) => part === ".." || part === ".")
  )
    return null;
  return { name: match[1]!, version: match[2]!, file: match[3]! };
}

/** A directory of a pinned package, for an import map prefix such as `three/addons/`. */
const packageDirectoryUrl = new RegExp(
  `^https://cdn\\.jsdelivr\\.net/npm/${packageName}@(\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?)/((?:[A-Za-z0-9._-]+/)*)$`,
  "u",
);

/**
 * The local route for a pinned package file (or a directory of one, for an
 * import map prefix), or null if not allowed.
 */
export function libraryRoute(url: string): string | null {
  const file = packageFile(url);
  if (file) return `/lib/${file.name}@${file.version}/${file.file}`;
  const directory = packageDirectoryUrl.exec(url);
  if (
    directory &&
    !directory[3]!.split("/").some((part) => part === ".." || part === ".")
  )
    return `/lib/${directory[1]}@${directory[2]}/${directory[3]}`;
  return null;
}

const packageHelp =
  "Load libraries and fonts as pinned npm package files from cdn.jsdelivr.net/npm with an exact version and file path, for example https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js or, as ES modules, https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js in an import map; or put files in the workspace.";

const limits = Object.freeze({
  maxPageBytes: 2 * 1024 * 1024,
  maxFileBytes: 4 * 1024 * 1024,
  maxTotalBytes: 12 * 1024 * 1024,
});

const mimeTypes: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".json": "application/json",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".bin": "application/octet-stream",
  ".txt": "text/plain",
};

/** Content types for files taken from a pinned package. */
export const packageMimeTypes: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".cjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".bin": "application/octet-stream",
  ".hdr": "application/octet-stream",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
};

export interface ImportedComposition {
  sha256: string;
  html: string;
}

export interface ImportOptions {
  /** Fetches (or reads from the local cache) a pinned npm package file. */
  fetchPackage?: (url: string) => Promise<Buffer>;
}

/** A file inside the workspace, refusing paths and links that leave it. */
async function workspaceFile(
  workspace: string,
  base: string,
  reference: string,
): Promise<{ path: string; bytes: Buffer }> {
  if (isAbsolute(reference) || /^[a-z][a-z0-9+.-]*:/iu.test(reference))
    throw new CompositionError(
      `"${reference.slice(0, 120)}" is not a workspace file. Keep scripts, styles, images and fonts as files next to the composition.`,
    );
  const candidate = normalize(join(base, reference.split(/[?#]/u)[0]!));
  const root = await realpath(workspace);
  const inside = relative(root, candidate);
  if (inside.startsWith("..") || isAbsolute(inside))
    throw new CompositionError(
      `"${reference.slice(0, 120)}" is outside the workspace.`,
    );
  let resolved: string;
  try {
    resolved = await realpath(candidate);
  } catch {
    throw new CompositionError(`"${reference.slice(0, 120)}" was not found.`);
  }
  const real = relative(root, resolved);
  if (real.startsWith("..") || isAbsolute(real))
    throw new CompositionError(
      `"${reference.slice(0, 120)}" is outside the workspace.`,
    );
  const stat = await lstat(resolved);
  if (!stat.isFile() || stat.size > limits.maxFileBytes)
    throw new CompositionError(
      `"${reference.slice(0, 120)}" must be a file of at most 4 MiB.`,
    );
  return { path: resolved, bytes: await readFile(resolved) };
}

const external = /^(?:https?:|\/\/)/iu;

/**
 * Reads `relativePath` (inside `workspace`) and returns the sealed page.
 */
export async function importComposition(
  workspace: string,
  relativePath: string,
  options: ImportOptions = {},
): Promise<ImportedComposition> {
  if (!/\.html?$/iu.test(relativePath))
    throw new CompositionError("A composition is an .html file.");
  const page = await workspaceFile(workspace, workspace, relativePath);
  if (page.bytes.length > limits.maxPageBytes)
    throw new CompositionError("The composition page is larger than 2 MiB.");
  const base = join(page.path, "..");
  let total = page.bytes.length;
  const dataUrl = async (reference: string): Promise<string> => {
    const file = await workspaceFile(workspace, base, reference);
    total += file.bytes.length;
    if (total > limits.maxTotalBytes)
      throw new CompositionError(
        "The composition and its files are larger than 12 MiB.",
      );
    const mime = mimeTypes[extname(file.path).toLowerCase()];
    if (!mime)
      throw new CompositionError(
        `"${reference.slice(0, 120)}" is not an image, font or JSON file.`,
      );
    return `data:${mime};base64,${file.bytes.toString("base64")}`;
  };
  const text = async (reference: string): Promise<string> => {
    const file = await workspaceFile(workspace, base, reference);
    total += file.bytes.length;
    if (total > limits.maxTotalBytes)
      throw new CompositionError(
        "The composition and its files are larger than 12 MiB.",
      );
    return file.bytes.toString("utf8");
  };
  /** A pinned package file, counted against the size limits. */
  const fetched = async (url: string): Promise<Buffer> => {
    if (!packageFile(url))
      throw new CompositionError(
        `Compositions cannot load "${url.slice(0, 120)}" from the network. ${packageHelp}`,
      );
    if (!options.fetchPackage)
      throw new CompositionError("Package files cannot be fetched here.");
    let bytes: Buffer;
    try {
      bytes = await options.fetchPackage(url);
    } catch {
      throw new CompositionError(
        `"${url.slice(0, 120)}" could not be downloaded. Check the package name, version and file.`,
      );
    }
    total += bytes.length;
    if (bytes.length > limits.maxFileBytes || total > limits.maxTotalBytes)
      throw new CompositionError(
        "The composition and its files are larger than 12 MiB. Load only the files you use (for example one font weight and subset).",
      );
    return bytes;
  };
  /** Inlines a stylesheet's files; `remote` is a package stylesheet's URL. */
  const inlineCss = async (css: string, remote?: string): Promise<string> => {
    // A font package's stylesheet lists a woff fallback; woff2 alone is enough.
    if (remote)
      css = css.replace(
        /,\s*url\(\s*["']?[^)"']+\.woff["']?\s*\)\s*format\(\s*["']woff["']\s*\)/giu,
        "",
      );
    let out = "";
    let last = 0;
    for (const match of css.matchAll(/url\(\s*(["']?)([^)"']+)\1\s*\)/giu)) {
      const reference = match[2]!.trim();
      out += css.slice(last, match.index);
      last = match.index! + match[0].length;
      if (reference.startsWith("data:") || reference.startsWith("#")) {
        out += match[0];
        continue;
      }
      const absolute = remote ? new URL(reference, remote).href : reference;
      if (remote || external.test(reference)) {
        const file = packageFile(absolute);
        const mime = file
          ? mimeTypes[extname(file.file).toLowerCase()]
          : undefined;
        if (!file || !mime)
          throw new CompositionError(
            `Compositions cannot load "${absolute.slice(0, 120)}" from the network. ${packageHelp}`,
          );
        out += `url("data:${mime};base64,${(await fetched(absolute)).toString("base64")}")`;
        continue;
      }
      out += `url("${await dataUrl(reference)}")`;
    }
    if (/@import\b/iu.test(css))
      throw new CompositionError(
        "@import is not supported; inline the styles instead.",
      );
    return out + css.slice(last);
  };

  let html = page.bytes.toString("utf8");
  // A root with data-composition-id is a HyperFrames composition (played by
  // its runtime); any other page is free-form and draws itself in
  // window.__seek(seconds) or through animations the stage bridge seeks.
  const hyperframes = /data-composition-id\s*=/iu.test(html);
  /** The script tag's other attributes (type="module" and so on). */
  const scriptAttributes = (before: string, after: string): string => {
    const kept = `${before} ${after}`
      .replace(/\s+/gu, " ")
      .replace(
        /\s*\b(?:integrity|crossorigin)(?:\s*=\s*(?:"[^"]*"|'[^']*'|\S+))?/giu,
        "",
      )
      .trimEnd();
    return kept && kept !== " "
      ? kept.startsWith(" ")
        ? kept
        : ` ${kept}`
      : "";
  };
  // Scripts: pinned libraries from the local cache, workspace scripts inline.
  const scripts: string[] = [];
  for (const match of html.matchAll(
    /<script\b([^>]*?)\bsrc\s*=\s*(["'])([^"']+)\2([^>]*)>\s*<\/script>/giu,
  )) {
    const source = match[3]!.trim();
    if (external.test(source)) {
      const route = libraryRoute(source);
      if (!route)
        throw new CompositionError(
          `"${source.slice(0, 120)}" cannot be loaded. ${packageHelp}`,
        );
      scripts.push(
        `<script${scriptAttributes(match[1]!, match[4]!)} src="${route}"></script>`,
      );
    } else
      scripts.push(
        `<script${scriptAttributes(match[1]!, match[4]!)}>${(await text(source)).replace(/<\/script/giu, "<\\/script")}</script>`,
      );
  }
  let index = 0;
  html = html.replace(
    /<script\b([^>]*?)\bsrc\s*=\s*(["'])([^"']+)\2([^>]*)>\s*<\/script>/giu,
    () => scripts[index++]!,
  );
  // Inline scripts and import maps (and the workspace scripts inlined above):
  // pinned package URLs, in imports and strings, point at the local cache.
  html = html.replace(
    /(<script\b[^>]*>)([\s\S]*?)(<\/script>)/giu,
    (_whole, open: string, body: string, close: string) =>
      `${open}${body.replace(
        /https:\/\/cdn\.jsdelivr\.net\/[^\s"'`)\\<>]+/giu,
        (url) => {
          const route = libraryRoute(url);
          if (!route)
            throw new CompositionError(
              `"${url.slice(0, 120)}" cannot be loaded. ${packageHelp}`,
            );
          return route;
        },
      )}${close}`,
  );
  // Script bodies are code, not markup: set them aside while the markup
  // passes below inline files and check attributes, then put them back.
  const codeBlocks: string[] = [];
  html = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, (whole) => {
    codeBlocks.push(whole);
    return `\u0000code${codeBlocks.length - 1}\u0000`;
  });
  // Stylesheets: workspace files inline; no network.
  const sheets: string[] = [];
  for (const match of html.matchAll(/<link\b[^>]*>/giu)) {
    const tag = match[0];
    const href = /\bhref\s*=\s*(["'])([^"']+)\1/iu.exec(tag)?.[2]?.trim();
    if (!/\brel\s*=\s*(["']?)stylesheet\1/iu.test(tag) || !href) {
      sheets.push(external.test(href ?? "") ? "" : tag);
      continue;
    }
    if (external.test(href)) {
      const file = packageFile(href);
      if (!file || !file.file.endsWith(".css"))
        throw new CompositionError(
          `Compositions cannot load the stylesheet "${href.slice(0, 120)}" from the network. ${packageHelp}`,
        );
      sheets.push(
        `<style>${await inlineCss((await fetched(href)).toString("utf8"), href)}</style>`,
      );
      continue;
    }
    sheets.push(`<style>${await inlineCss(await text(href))}</style>`);
  }
  index = 0;
  html = html.replace(/<link\b[^>]*>/giu, () => sheets[index++]!);
  // Inline styles and style attributes.
  const styles: string[] = [];
  for (const match of html.matchAll(/<style\b([^>]*)>([\s\S]*?)<\/style>/giu))
    styles.push(`<style${match[1]}>${await inlineCss(match[2]!)}</style>`);
  index = 0;
  html = html.replace(
    /<style\b([^>]*)>([\s\S]*?)<\/style>/giu,
    () => styles[index++]!,
  );
  // Images and other media by attribute.
  const attributes: string[] = [];
  const attributePattern =
    /\b(src|href|xlink:href|poster)\s*=\s*(["'])([^"']*)\2/giu;
  for (const match of html.matchAll(attributePattern)) {
    const value = match[3]!.trim();
    if (
      !value ||
      value.startsWith("data:") ||
      value.startsWith("#") ||
      value.startsWith("/lib/") ||
      value.startsWith("blob:")
    ) {
      attributes.push(match[0]);
      continue;
    }
    if (external.test(value))
      throw new CompositionError(
        `Compositions cannot load "${value.slice(0, 120)}" from the network. Put the file in the workspace.`,
      );
    attributes.push(
      `${match[1]}=${match[2]}${await dataUrl(value)}${match[2]}`,
    );
  }
  index = 0;
  html = html.replace(attributePattern, () => attributes[index++]!);
  // The stage bridge comes first, after the HyperFrames runtime for a
  // HyperFrames composition. A transparent page over the video: its color
  // scheme matches the frame.
  html = html.replace(
    /\u0000code(\d+)\u0000/gu,
    (_whole, at: string) => codeBlocks[Number(at)]!,
  );
  const runtime = `<style>:root{color-scheme:normal!important}</style>${
    hyperframes ? '<script src="/lib/hyperframes-runtime.js"></script>' : ""
  }<script src="/lib/stage-bridge.js"></script>`;
  html = /<head\b[^>]*>/iu.test(html)
    ? html.replace(/<head\b[^>]*>/iu, (head) => `${head}${runtime}`)
    : `${runtime}${html}`;
  if (Buffer.byteLength(html) > limits.maxTotalBytes)
    throw new CompositionError(
      "The composition and its files are larger than 12 MiB.",
    );
  return {
    sha256: createHash("sha256").update(html).digest("hex"),
    html,
  };
}

/** Where stored compositions live, by hash. */
export function compositionFile(root: string, sha256: string): string {
  if (!/^[a-f0-9]{64}$/u.test(sha256)) throw new Error("Invalid composition");
  return join(root, `${sha256}.html`);
}

/** True when `name` is a workspace-relative path without tricks. */
export function plainRelativePath(name: unknown): name is string {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    name.length <= 260 &&
    !isAbsolute(name) &&
    !name.split(/[\\/]/u).some((part) => part === "..") &&
    !name.includes("\u0000") &&
    !name.startsWith(sep)
  );
}
