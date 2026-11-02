/**
 * A linear-time reader for the HTML and CSS of a composition page.
 *
 * The page is written by a model, so it is untrusted input to the main
 * process: reading it must take time proportional to its size for every
 * input. Nothing here uses a regular expression with a quantifier over
 * unbounded input; every position is consumed once, by `indexOf` jumps and
 * single character scans, and a search that found nothing is never repeated.
 * The page is read the way a browser tokenizes it (comments, quoted attribute
 * values, script and style bodies), so what is rewritten is what would run.
 */

/** Characters the HTML tokenizer treats as white space inside a tag. */
const isTagSpace = (code: number): boolean =>
  code === 32 || code === 9 || code === 10 || code === 12 || code === 13;

const isLetter = (code: number): boolean =>
  (code >= 65 && code <= 90) || (code >= 97 && code <= 122);

/** The characters `\w` matches. */
const isWord = (code: number): boolean =>
  isLetter(code) || (code >= 48 && code <= 57) || code === 95;

/** The characters `\s` matches (and `trim` removes). */
export function isSpace(code: number): boolean {
  return (
    code === 32 ||
    (code >= 9 && code <= 13) ||
    code === 160 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 ||
    code === 0xfeff
  );
}

/** Lower-cases ASCII letters only, so every index stays valid. */
export function asciiLower(text: string): string {
  return text.replace(/[A-Z]+/gu, (run) => run.toLowerCase());
}

/** An attribute of a start tag, with the places it occupies in the page. */
export interface Attribute {
  /** The lower-cased name. */
  name: string;
  nameStart: number;
  nameEnd: number;
  /** The value without its quotes, or -1 for an attribute without one. */
  valueStart: number;
  valueEnd: number;
  /** The quote character around the value, or "" for none. */
  quote: string;
  /** The end of the attribute, after its closing quote. */
  end: number;
}

export interface ScannedTag {
  /** The lower-cased tag name. */
  name: string;
  /** After the closing `>`, or -1 when the page ends inside the tag. */
  end: number;
  attrs: Attribute[];
}

/** The attribute names whose files the sealed page inlines. */
const fileAttributes = ["src", "href", "xlink:href", "poster"];

/**
 * How many characters of `name` form an inlinable file attribute (`src`,
 * `data-src`, `xlink:href` ...): the key must start the name or follow a
 * character that is not a word character. 0 for any other name.
 */
export function fileAttributeLength(name: string): number {
  for (const key of fileAttributes) {
    if (!name.endsWith(key)) continue;
    const before = name.length - key.length - 1;
    if (before < 0 || !isWord(name.charCodeAt(before))) return key.length;
  }
  return 0;
}

/** Whether a tag's attribute is worth recording when only some are kept. */
function isRecorded(name: string): boolean {
  return name === "rel" || fileAttributeLength(name) > 0;
}

/**
 * Reads a tag whose name starts at `at` (just after `<` or `</`), quote-aware,
 * to its closing `>`. With `all` false only the attributes a page rewrite
 * needs are recorded, which keeps a tag with a million attributes cheap.
 */
export function scanTag(text: string, at: number, all: boolean): ScannedTag {
  const length = text.length;
  const attrs: Attribute[] = [];
  let i = at;
  while (i < length) {
    const code = text.charCodeAt(i);
    if (isTagSpace(code) || code === 47 || code === 62) break;
    i++;
  }
  const name = text.slice(at, i).toLowerCase();
  for (;;) {
    while (i < length) {
      const code = text.charCodeAt(i);
      if (!isTagSpace(code) && code !== 47) break;
      i++;
    }
    if (i >= length) return { name, end: -1, attrs };
    if (text.charCodeAt(i) === 62) return { name, end: i + 1, attrs };
    const nameStart = i;
    i++;
    while (i < length) {
      const code = text.charCodeAt(i);
      if (isTagSpace(code) || code === 47 || code === 62 || code === 61) break;
      i++;
    }
    const nameEnd = i;
    let valueStart = -1;
    let valueEnd = -1;
    let quote = "";
    let end = nameEnd;
    let j = i;
    while (j < length && isTagSpace(text.charCodeAt(j))) j++;
    if (j < length && text.charCodeAt(j) === 61) {
      j++;
      while (j < length && isTagSpace(text.charCodeAt(j))) j++;
      if (j >= length) return { name, end: -1, attrs };
      const open = text.charCodeAt(j);
      if (open === 34 || open === 39) {
        quote = open === 34 ? '"' : "'";
        const close = text.indexOf(quote, j + 1);
        if (close < 0) return { name, end: -1, attrs };
        valueStart = j + 1;
        valueEnd = close;
        end = close + 1;
      } else {
        let k = j;
        while (k < length) {
          const code = text.charCodeAt(k);
          if (isTagSpace(code) || code === 62) break;
          k++;
        }
        valueStart = j;
        valueEnd = k;
        end = k;
      }
      i = end;
    }
    // The last letter narrows the names worth lower-casing: src, href,
    // poster and rel end in c, f, r and l.
    const last = text.charCodeAt(nameEnd - 1) | 32;
    if (all || last === 99 || last === 102 || last === 114 || last === 108) {
      const lowered = text.slice(nameStart, nameEnd).toLowerCase();
      if (all || isRecorded(lowered))
        attrs.push({
          name: lowered,
          nameStart,
          nameEnd,
          valueStart,
          valueEnd,
          quote,
          end,
        });
    }
  }
}

/** A start tag the page rewrite looks at, or a raw-text element. */
export interface TagToken {
  kind: "tag";
  name: string;
  start: number;
  end: number;
  attrs: Attribute[];
}

/** A `<script>` or `<style>` with its body and closing tag. */
export interface RawToken {
  kind: "script" | "style";
  start: number;
  /** After the opening tag; the body runs from here to `bodyEnd`. */
  bodyStart: number;
  bodyEnd: number;
  /** After the closing tag. */
  end: number;
  attrs: Attribute[];
}

export type Token = TagToken | RawToken;

/**
 * Finds the end tag of a raw-text element: `</name` followed by white space,
 * `/` or `>`, then the rest of that tag. Null when the page ends first.
 */
function findRawEnd(
  text: string,
  lower: string,
  name: string,
  from: number,
): { closeStart: number; end: number } | null {
  const needle = `</${name}`;
  let at = lower.indexOf(needle, from);
  while (at >= 0) {
    const next = text.charCodeAt(at + needle.length);
    if (isTagSpace(next) || next === 47 || next === 62) {
      const closing = scanTag(text, at + 2, false);
      return {
        closeStart: at,
        end: closing.end < 0 ? text.length : closing.end,
      };
    }
    at = lower.indexOf(needle, at + 1);
  }
  return null;
}

/** The end of a comment that starts at `at` (`<!--`), or the page's end. */
function commentEnd(text: string, at: number): number {
  const length = text.length;
  let i = at + 4;
  if (text.charCodeAt(i) === 62) return i + 1;
  if (text.startsWith("->", i)) return i + 2;
  for (;;) {
    i = text.indexOf("--", i);
    if (i < 0) return length;
    const next = text.charCodeAt(i + 2);
    if (next === 62) return i + 3;
    if (next === 33 && text.charCodeAt(i + 3) === 62) return i + 4;
    i++;
  }
}

/**
 * Splits a page into the tokens a rewrite acts on, in page order: start tags
 * that have a file attribute (or are script, style, link or head), and
 * script and style elements whole. Comments, end tags, text and every tag the
 * rewrite does not touch are not tokens; they stay as the bytes between.
 * A script or style that is never closed, and anything after a tag or
 * comment the page ends inside, is left as is (a browser reads it as inert).
 */
export function tokenize(text: string, lower: string): Token[] {
  const tokens: Token[] = [];
  const length = text.length;
  let pos = 0;
  while (pos < length) {
    const open = text.indexOf("<", pos);
    if (open < 0) break;
    const next = text.charCodeAt(open + 1);
    if (isLetter(next)) {
      const tag = scanTag(text, open + 1, false);
      if (tag.end < 0) break;
      pos = tag.end;
      if (tag.name === "script" || tag.name === "style") {
        const close = findRawEnd(text, lower, tag.name, tag.end);
        if (!close) break;
        tokens.push({
          kind: tag.name,
          start: open,
          bodyStart: tag.end,
          bodyEnd: close.closeStart,
          end: close.end,
          attrs: tag.attrs,
        });
        pos = close.end;
      } else if (
        tag.attrs.length > 0 ||
        tag.name === "link" ||
        tag.name === "head"
      )
        tokens.push({
          kind: "tag",
          name: tag.name,
          start: open,
          end: tag.end,
          attrs: tag.attrs,
        });
    } else if (next === 47) {
      const after = text.charCodeAt(open + 2);
      if (isLetter(after)) {
        const tag = scanTag(text, open + 2, false);
        if (tag.end < 0) break;
        pos = tag.end;
      } else if (after === 62) pos = open + 3;
      else {
        const end = text.indexOf(">", open + 2);
        if (end < 0) break;
        pos = end + 1;
      }
    } else if (next === 33 && text.startsWith("--", open + 2)) {
      pos = commentEnd(text, open);
    } else if (next === 33 || next === 63) {
      const end = text.indexOf(">", open + 2);
      if (end < 0) break;
      pos = end + 1;
    } else pos = open + 1;
  }
  return tokens;
}

/** Whether the page mentions `data-composition-id` followed by `=`. */
export function mentionsCompositionId(lower: string): boolean {
  const needle = "data-composition-id";
  let at = lower.indexOf(needle);
  while (at >= 0) {
    let i = at + needle.length;
    while (i < lower.length && isSpace(lower.charCodeAt(i))) i++;
    if (lower.charCodeAt(i) === 61) return true;
    at = lower.indexOf(needle, at + 1);
  }
  return false;
}

/** Whether `lower` has `@import` as a word. */
export function hasCssImport(lower: string): boolean {
  let at = lower.indexOf("@import");
  while (at >= 0) {
    if (!isWord(lower.charCodeAt(at + 7))) return true;
    at = lower.indexOf("@import", at + 1);
  }
  return false;
}

/**
 * The next `)`, `"` or `'` at or after a position, remembering the last
 * answer: a search that starts inside the previous run finds the same end
 * without scanning the run again.
 */
class RunEnd {
  private readonly pattern = /[)"']/gu;
  private from = -1;
  private found = -1;
  private readonly text: string;

  constructor(text: string) {
    this.text = text;
  }

  next(from: number): number {
    if (this.from >= 0 && from >= this.from && from <= this.found)
      return this.found;
    this.pattern.lastIndex = from;
    const match = this.pattern.exec(this.text);
    this.from = from;
    this.found = match ? match.index : this.text.length;
    return this.found;
  }
}

/** A CSS `url( ... )` reference. */
export interface CssUrl {
  /** Where `url(` starts and where the closing `)` ends. */
  start: number;
  end: number;
  /** The text between the parentheses and quotes, not trimmed. */
  reference: string;
}

/**
 * Matches `url(` + optional white space + optional quote + a non-empty
 * reference without `)` or quotes + the same quote + white space + `)` at
 * `at`; the same strings `url\(\s*(["']?)([^)"']+)\1\s*\)` accepts.
 */
function matchCssUrl(css: string, at: number, run: RunEnd): CssUrl | null {
  const length = css.length;
  const afterOpen = at + 4;
  let i = afterOpen;
  while (i < length && isSpace(css.charCodeAt(i))) i++;
  let quote = "";
  if (css[i] === '"' || css[i] === "'") {
    quote = css[i]!;
    i++;
  }
  const end = run.next(i);
  if (end === i) {
    // Nothing but white space before `)`: the white space is the reference.
    if (quote === "" && i > afterOpen && css[i] === ")")
      return { start: at, end: i + 1, reference: css[i - 1]! };
    return null;
  }
  let close = end;
  if (quote !== "") {
    if (css[end] !== quote) return null;
    close = end + 1;
  }
  while (close < length && isSpace(css.charCodeAt(close))) close++;
  if (css[close] !== ")") return null;
  return { start: at, end: close + 1, reference: css.slice(i, end) };
}

/** The `url(...)` references of a stylesheet, in order. */
export function* cssUrls(css: string, lower: string): Generator<CssUrl> {
  const run = new RunEnd(css);
  let at = lower.indexOf("url(");
  while (at >= 0) {
    const match = matchCssUrl(css, at, run);
    if (match) {
      yield match;
      at = lower.indexOf("url(", match.end);
    } else at = lower.indexOf("url(", at + 1);
  }
}

/**
 * Where a `, url(x.woff) format("woff")` fallback that starts with the comma
 * at `comma` ends, or -1. The same strings the pattern
 * `,\s*url\(\s*["']?[^)"']+\.woff["']?\s*\)\s*format\(\s*["']woff["']\s*\)`
 * accepts, case-insensitively.
 */
function woffFallbackEnd(
  css: string,
  lower: string,
  comma: number,
  run: RunEnd,
): number {
  const length = css.length;
  let i = comma + 1;
  while (i < length && isSpace(css.charCodeAt(i))) i++;
  if (!lower.startsWith("url(", i)) return -1;
  i += 4;
  let start = i;
  while (start < length && isSpace(css.charCodeAt(start))) start++;
  if (css[start] === '"' || css[start] === "'") start++;
  else start = i;
  const end = run.next(start);
  let after: number;
  if (css[end] === ")") {
    let word = end;
    while (word > start && isSpace(css.charCodeAt(word - 1))) word--;
    if (word - start < 6 || !lower.startsWith(".woff", word - 5)) return -1;
    after = end + 1;
  } else if (css[end] === '"' || css[end] === "'") {
    if (end - start < 6 || !lower.startsWith(".woff", end - 5)) return -1;
    after = end + 1;
    while (after < length && isSpace(css.charCodeAt(after))) after++;
    if (css[after] !== ")") return -1;
    after++;
  } else return -1;
  while (after < length && isSpace(css.charCodeAt(after))) after++;
  if (!lower.startsWith("format(", after)) return -1;
  after += 7;
  while (after < length && isSpace(css.charCodeAt(after))) after++;
  if (css[after] !== '"' && css[after] !== "'") return -1;
  after++;
  if (!lower.startsWith("woff", after)) return -1;
  after += 4;
  if (css[after] !== '"' && css[after] !== "'") return -1;
  after++;
  while (after < length && isSpace(css.charCodeAt(after))) after++;
  return css[after] === ")" ? after + 1 : -1;
}

/** A stylesheet without its `woff` font fallbacks (woff2 alone is enough). */
export function withoutWoffFallbacks(css: string): string {
  const lower = asciiLower(css);
  const run = new RunEnd(css);
  const parts: string[] = [];
  let last = 0;
  let from = 0;
  for (;;) {
    const comma = css.indexOf(",", from);
    if (comma < 0) break;
    const end = woffFallbackEnd(css, lower, comma, run);
    if (end < 0) {
      from = comma + 1;
      continue;
    }
    parts.push(css.slice(last, comma));
    last = end;
    from = end;
  }
  if (last === 0) return css;
  parts.push(css.slice(last));
  return parts.join("");
}

/** Whether a character ends a URL found in script code. */
function endsScriptUrl(code: number): boolean {
  return (
    isSpace(code) ||
    code === 34 ||
    code === 39 ||
    code === 96 ||
    code === 41 ||
    code === 92 ||
    code === 60 ||
    code === 62
  );
}

/**
 * Calls `rewrite` for every `https://cdn.jsdelivr.net/...` URL in script
 * code (a URL ends at white space, a quote, a backtick, `)`, `\`, `<` or `>`)
 * and replaces it with the result.
 */
export function rewriteScriptUrls(
  body: string,
  rewrite: (url: string) => string,
): string {
  const prefix = "https://cdn.jsdelivr.net/";
  const lower = asciiLower(body);
  let at = lower.indexOf(prefix);
  if (at < 0) return body;
  const parts: string[] = [];
  let last = 0;
  while (at >= 0) {
    const start = at + prefix.length;
    let end = start;
    while (end < body.length && !endsScriptUrl(body.charCodeAt(end))) end++;
    if (end === start) {
      at = lower.indexOf(prefix, at + 1);
      continue;
    }
    parts.push(body.slice(last, at), rewrite(body.slice(at, end)));
    last = end;
    at = lower.indexOf(prefix, end);
  }
  parts.push(body.slice(last));
  return parts.join("");
}
