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
 */

export class CompositionError extends Error {
  override name = "CompositionError";
}

/** Animation libraries a composition may load, by their exact npm name. */
export const compositionLibraries: ReadonlySet<string> = new Set([
  "gsap",
  "lottie-web",
  "three",
  "animejs",
]);

const libraryUrl =
  /^https:\/\/cdn\.jsdelivr\.net\/npm\/(@?[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)?)@(\d+\.\d+\.\d+)\/([A-Za-z0-9._/-]+\.js)$/u;

/** The local route for a pinned library file, or null if not allowed. */
export function libraryRoute(url: string): string | null {
  const match = libraryUrl.exec(url);
  if (!match || !compositionLibraries.has(match[1]!)) return null;
  if (match[3]!.split("/").some((part) => part === ".." || part === "."))
    return null;
  return `/lib/${match[1]}@${match[2]}/${match[3]}`;
}

const fontUrl =
  /^https:\/\/cdn\.jsdelivr\.net\/npm\/(@fontsource(?:-variable)?\/[a-z0-9][a-z0-9-]*)@(\d+\.\d+\.\d+)\/([A-Za-z0-9._/-]+\.(?:css|woff2|woff))$/u;

/**
 * A pinned Fontsource file (an open-source font package) on jsDelivr, or
 * null. Fontsource packages carry OFL or similarly open licences.
 */
export function fontPackageFile(
  url: string,
): { name: string; version: string; file: string } | null {
  const match = fontUrl.exec(url);
  if (
    !match ||
    match[3]!.split("/").some((part) => part === ".." || part === ".")
  )
    return null;
  return { name: match[1]!, version: match[2]!, file: match[3]! };
}

const fontHelp =
  'Load fonts as pinned Fontsource packages, for example <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@fontsource/inter@5.2.8/latin-700.css">, or put font files in the workspace and use @font-face.';

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
};

export interface ImportedComposition {
  sha256: string;
  html: string;
}

export interface ImportOptions {
  /** Fetches (or reads from the local cache) a pinned Fontsource file. */
  fetchFont?: (url: string) => Promise<Buffer>;
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
  /** A pinned Fontsource file, counted against the size limits. */
  const font = async (url: string): Promise<Buffer> => {
    if (!fontPackageFile(url))
      throw new CompositionError(
        `Compositions cannot load "${url.slice(0, 120)}" from the network. ${fontHelp}`,
      );
    if (!options.fetchFont)
      throw new CompositionError("Fonts cannot be fetched here.");
    let bytes: Buffer;
    try {
      bytes = await options.fetchFont(url);
    } catch {
      throw new CompositionError(
        `"${url.slice(0, 120)}" could not be downloaded. Check the package name, version and file.`,
      );
    }
    total += bytes.length;
    if (bytes.length > limits.maxFileBytes || total > limits.maxTotalBytes)
      throw new CompositionError(
        "The composition and its files are larger than 12 MiB. Load only the font weights and subsets you use (for example latin-700.css).",
      );
    return bytes;
  };
  /** Inlines a stylesheet's files; `remote` is a Fontsource stylesheet's URL. */
  const inlineCss = async (css: string, remote?: string): Promise<string> => {
    // A Fontsource stylesheet lists a woff fallback; woff2 alone is enough.
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
        const file = fontPackageFile(absolute);
        if (!file || !/\.woff2?$/u.test(file.file))
          throw new CompositionError(
            `Compositions cannot load "${absolute.slice(0, 120)}" from the network. ${fontHelp}`,
          );
        const mime = file.file.endsWith(".woff2") ? "font/woff2" : "font/woff";
        out += `url("data:${mime};base64,${(await font(absolute)).toString("base64")}")`;
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
  if (!/data-composition-id\s*=/iu.test(html))
    throw new CompositionError(
      "This is not a HyperFrames composition: its root element needs data-composition-id (see the hyperframes-core skill).",
    );
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
          `Compositions can load only pinned gsap, lottie-web, three or animejs files from cdn.jsdelivr.net/npm (exact x.y.z versions), not "${source.slice(0, 120)}".`,
        );
      scripts.push(`<script src="${route}"></script>`);
    } else
      scripts.push(
        `<script>${(await text(source)).replace(/<\/script/giu, "<\\/script")}</script>`,
      );
  }
  let index = 0;
  html = html.replace(
    /<script\b([^>]*?)\bsrc\s*=\s*(["'])([^"']+)\2([^>]*)>\s*<\/script>/giu,
    () => scripts[index++]!,
  );
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
      const file = fontPackageFile(href);
      if (!file || !file.file.endsWith(".css"))
        throw new CompositionError(
          `Compositions cannot load the stylesheet "${href.slice(0, 120)}" from the network. ${fontHelp}`,
        );
      sheets.push(
        `<style>${await inlineCss((await font(href)).toString("utf8"), href)}</style>`,
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
  // The HyperFrames runtime and the stage bridge come first.
  // A transparent page over the video: its color scheme matches the frame.
  const runtime =
    '<style>:root{color-scheme:normal!important}</style><script src="/lib/hyperframes-runtime.js"></script><script src="/lib/stage-bridge.js"></script>';
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
