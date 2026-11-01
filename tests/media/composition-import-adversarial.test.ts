import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CompositionError,
  importComposition,
} from "../../apps/desktop/src/composition-import.ts";

/**
 * The page a model writes is untrusted input to the main process: sealing it
 * must take time proportional to its size, whatever it contains. Each shape
 * below is a page of a repeated, usually unterminated, fragment that makes a
 * backtracking regular expression quadratic or worse.
 */

const MiB = 1024 * 1024;
const sizes = [512 * 1024, MiB, 2 * MiB];
/** A generous absolute bound for the largest page the importer accepts. */
const absoluteLimitMs = 3000;
/** Doubling a page may take at most 3 times as long, or this long. */
const growthFloorMs = 100;

const repeat = (unit: string, bytes: number): string =>
  unit.repeat(Math.max(1, Math.floor(bytes / unit.length)));

const pinned = "https://cdn.jsdelivr.net/npm/p@1.0.0";

/** Page text of at most `bytes` bytes for a size. */
type Shape = (bytes: number) => string;

const repeated =
  (unit: string, before = "", after = ""): Shape =>
  (bytes) =>
    `${before}${repeat(unit, bytes - before.length - after.length)}${after}`;

const pageShapes: Record<string, Shape> = {
  "repeated <script ": repeated("<script "),
  "repeated <script src=": repeated("<script src="),
  'repeated <script src="': repeated('<script src="'),
  "repeated <script src='": repeated("<script src='"),
  "repeated closed-quote scripts without an end tag":
    repeated('<script src="a" '),
  "repeated script src and unterminated end tag": repeated(
    '<script src="a"></script',
  ),
  "repeated empty scripts with a tail": repeated(
    '<script src="https://cdn.jsdelivr.net/npm/p@1.0.0/a.js"></script>\n',
  ),
  "repeated <script> openers": repeated("<script>"),
  "repeated </script closers": repeated("</script "),
  "repeated <style>": repeated("<style>"),
  "repeated <style ": repeated("<style "),
  "repeated <style> and url(": repeated("<style>url("),
  "repeated <link ": repeated("<link "),
  "repeated <link rel=stylesheet href=": repeated("<link rel=stylesheet href="),
  'repeated <link rel="stylesheet" href="': repeated(
    '<link rel="stylesheet" href="',
  ),
  'repeated <img src="': repeated('<img src="'),
  "repeated src='": repeated("src='"),
  'repeated src="x" src=\'': repeated('src="x" src=\''),
  "repeated href=": repeated("href="),
  "repeated poster and xlink:href": repeated("poster=\"x xlink:href='"),
  "repeated url(": repeated("url("),
  "repeated <!--": repeated("<!--"),
  "repeated <!-- --!": repeated("<!-- --!"),
  "repeated closed comments": repeated("<!---->"),
  "repeated double quotes": repeated('"'),
  "repeated single quotes": repeated("'"),
  "repeated <scr": repeated("<scr"),
  "repeated <scrip": repeated("<scrip"),
  "repeated </scr": repeated("</scr"),
  "repeated <": repeated("<"),
  "repeated <!": repeated("<!"),
  "repeated <?": repeated("<?"),
  "repeated <a b=": repeated("<a b="),
  'repeated <a b="': repeated('<a b="'),
  "repeated <head ": repeated("<head "),
  "repeated data-composition-id ": repeated("data-composition-id "),
  "style with repeated url(": repeated("url(", "<style>", "</style>"),
  "style with repeated url( and spaces": repeated(
    "url(      ",
    "<style>",
    "</style>",
  ),
  'style with repeated url(" and spaces': repeated(
    'url( "   ',
    "<style>",
    "</style>",
  ),
  "style with repeated quoted url(": repeated('url("a ', "<style>", "</style>"),
  "style with many data urls": repeated("url(data:x) ", "<style>", "</style>"),
  "style with repeated @import": repeated("@import ", "<style>", "</style>"),
  "script with repeated cdn prefix": repeated(
    "https://cdn.jsdelivr.net/",
    "<script>",
    "</script>",
  ),
  "script with many pinned urls": repeated(
    `"${pinned}/a.js" `,
    "<script>",
    "</script>",
  ),
  "script with repeated end-tag lookalikes": repeated(
    "</scripts </scrip ",
    "<script>",
    "</script>",
  ),
  "tag with an enormous attribute list": repeated("a ", "<div ", ">"),
  "tag with an unterminated quote late": repeated("a='b' ", "<div ", '"'),
};

/** Stylesheets served for a pinned package link. */
const stylesheetShapes: Record<string, Shape> = {
  "fetched css with repeated ,url(": repeated(",url("),
  "fetched css with repeated , url(": repeated(", url("),
  "fetched css with repeated ,": repeated(","),
  "fetched css with commas and spaces": repeated(",     "),
  "fetched css with repeated woff fallbacks": repeated(
    ',url(a.woff) format("woff")',
  ),
  "fetched css with unterminated woff fallbacks": repeated(',url("a.woff'),
  "fetched css with repeated url(": repeated("url("),
  "fetched css with repeated url( and spaces": repeated("url(     "),
  "fetched css with repeated @import": repeated("@import "),
};

type ImportOptions = Parameters<typeof importComposition>[2];

/** One sealing at a size: the page text and the package files it can fetch. */
interface Case {
  html: string;
  options?: ImportOptions;
}

/** The fastest of a few runs, which keeps noise out of the growth check. */
async function timed(workspace: string, input: Case): Promise<number> {
  await writeFile(join(workspace, "page.html"), input.html);
  let best = Infinity;
  for (let run = 0; run < 5; run++) {
    const started = performance.now();
    try {
      await importComposition(workspace, "page.html", input.options);
    } catch (error) {
      // A page may be refused, with a reason a person can act on, but never
      // fail any other way.
      assert.ok(error instanceof CompositionError, String(error));
    }
    best = Math.min(best, performance.now() - started);
  }
  return best;
}

async function assertLinear(
  name: string,
  build: (bytes: number) => Case,
): Promise<void> {
  const workspace = await mkdtemp(join(tmpdir(), "composition-linear-"));
  try {
    // A busy machine can slow one measurement; quadratic work is slow in
    // every attempt, so the test passes if any of a few attempts is linear.
    let failure = "";
    for (let attempt = 0; attempt < 3; attempt++) {
      const measured: number[] = [];
      for (const size of sizes)
        measured.push(await timed(workspace, build(size)));
      const summary = `${name}: ${sizes.map((size, at) => `${size / 1024} KiB ${measured[at]!.toFixed(0)} ms`).join(", ")}`;
      if (measured.at(-1)! >= absoluteLimitMs)
        failure = `${summary} exceeds ${absoluteLimitMs} ms`;
      else if (
        measured.some(
          (time, at) =>
            at > 0 && time > 3 * Math.max(measured[at - 1]!, growthFloorMs),
        )
      )
        failure = `${summary} grows faster than linearly`;
      else return;
    }
    assert.fail(failure);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

for (const [name, shape] of Object.entries(pageShapes))
  test(`sealing a page of ${name} takes linear time`, async () => {
    await assertLinear(name, (bytes) => ({ html: shape(bytes) }));
  });

const linkPage = `<html><head><link rel="stylesheet" href="${pinned}/a.css"></head></html>`;

for (const [name, shape] of Object.entries(stylesheetShapes))
  test(`sealing a pinned stylesheet of ${name} takes linear time`, async () => {
    await assertLinear(name, (bytes) => ({
      html: linkPage,
      options: { fetchPackage: async () => Buffer.from(shape(bytes)) },
    }));
  });

test("the page is read the way a browser reads it", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "composition-read-"));
  try {
    await writeFile(join(workspace, "logo.svg"), "<svg/>");
    const seal = async (html: string): Promise<string> => {
      await writeFile(join(workspace, "page.html"), html);
      return (await importComposition(workspace, "page.html")).html;
    };
    // A comment is inert: nothing in it is fetched, refused or taken for the
    // head; the real head still gets the runtime.
    const commented = await seal(
      '<!-- <head> <img src="https://example.com/x.png"> --><html><head></head><body></body></html>',
    );
    assert.match(commented, /<head><style>:root\{color-scheme/u);
    assert.match(commented, /<img src="https:\/\/example\.com\/x\.png"> -->/u);
    // A `>` inside a quoted value does not end the tag, and the file after it
    // is still inlined; unquoted values are inlined too.
    const quoted = await seal(
      '<img alt="a > b" src="logo.svg"><img src=logo.svg>',
    );
    assert.equal(
      quoted.match(/src="data:image\/svg\+xml;base64,/gu)?.length,
      2,
    );
    assert.match(quoted, /alt="a > b"/u);
    // Text that only looks like an attribute is not one.
    assert.match(
      await seal('<p>use src="https://example.com/x.png" here</p>'),
      /use src="https:\/\/example\.com\/x\.png" here/u,
    );
    // An unterminated script is inert, as in a browser.
    assert.match(
      await seal('<script>var a = "<img src=x.png>";'),
      /var a = "<img src=x\.png>";$/u,
    );
    // Everything not rewritten keeps its exact bytes.
    const odd = "<DIV   Class = 'x'\n>t &amp; <b>u</b></DIV >\r\n";
    assert.ok((await seal(odd)).endsWith(odd));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
