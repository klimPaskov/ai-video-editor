import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { importComposition } from "../../apps/desktop/src/composition-import.ts";

/** A workspace with one composition page; returns what sealing it says. */
async function sealed(
  page: string,
  files: Record<string, string> = {},
  fetchPackage?: (url: string) => Promise<Buffer>,
) {
  const workspace = await mkdtemp(join(tmpdir(), "freeform-"));
  try {
    const folder = join(workspace, "compositions", "free");
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "index.html"), page);
    for (const [name, content] of Object.entries(files))
      await writeFile(join(folder, name), content);
    return await importComposition(workspace, "compositions/free/index.html", {
      ...(fetchPackage ? { fetchPackage } : {}),
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

const refusal = (pattern: RegExp) => (error: Error) => {
  assert.equal(error.name, "CompositionError");
  assert.match(error.message, pattern);
  return true;
};

test("a free-form page seals without the HyperFrames runtime", async () => {
  const { html } = await sealed(`<!doctype html><html><head></head><body>
<canvas id="c" width="640" height="360"></canvas>
<script>
window.__duration = 4;
window.__seek = (seconds) => {
  const context = document.getElementById("c").getContext("2d");
  context.clearRect(0, 0, 640, 360);
  context.fillRect(seconds * 100, 40, 80, 80);
};
</script></body></html>`);
  // The bridge is injected first; a page with no data-composition-id does
  // not get the HyperFrames runtime.
  assert.match(html, /\/lib\/stage-bridge\.js/u);
  assert.doesNotMatch(html, /hyperframes-runtime/u);
  assert.match(html, /window\.__seek = /u);
  // A HyperFrames composition still gets it, before the bridge.
  const hyperframes = await sealed(
    `<html><head></head><body><div data-composition-id="main" data-width="1" data-height="1" data-duration="1"></div></body></html>`,
  );
  assert.ok(
    hyperframes.html.indexOf("hyperframes-runtime") <
      hyperframes.html.indexOf("stage-bridge"),
  );
});

test("ES modules, import maps and strings use the local package cache", async () => {
  const { html } = await sealed(`<!doctype html><html><head>
<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js","three/addons/":"https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/"}}</script>
</head><body>
<script type="module" integrity="sha384-abc" crossorigin="anonymous" src="https://cdn.jsdelivr.net/npm/pixi.js@8.0.0/dist/pixi.min.mjs"></script>
<script type="module">
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
const later = () => import("https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js");
window.__seek = () => {};
</script></body></html>`);
  assert.doesNotMatch(html, /cdn\.jsdelivr\.net/u);
  assert.ok(
    html.includes(
      '"three":"/lib/three@0.170.0/build/three.module.js","three/addons/":"/lib/three@0.170.0/examples/jsm/"',
    ),
  );
  // The module attribute stays; integrity and crossorigin do not (the file
  // is served locally).
  assert.ok(
    html.includes(
      '<script type="module" src="/lib/pixi.js@8.0.0/dist/pixi.min.mjs"></script>',
    ),
  );
  assert.ok(html.includes('import("/lib/d3@7.9.0/dist/d3.min.js")'));
});

test("workspace scripts keep their type; script code is not rewritten as markup", async () => {
  const { html } = await sealed(
    `<!doctype html><html><head><script type="module" src="scene.js"></script></head><body>
<img id="a" src="logo.svg">
<script>
const image = new Image();
image.src = "frame-" + 3 + ".png";
const link = document.createElement("a");
link.href = "https://example.com/not-fetched";
document.body.append('<link rel="stylesheet" href="https://example.com/x.css">');
window.__seek = () => {};
</script></body></html>`,
    {
      "scene.js": "export const answer = 42;",
      "logo.svg": "<svg xmlns='http://www.w3.org/2000/svg'/>",
    },
  );
  assert.ok(html.includes('<script type="module">export const answer = 42;'));
  // Markup attributes are inlined; the same text inside script code is not
  // treated as an attribute (it would have been refused as a network load).
  assert.match(html, /<img id="a" src="data:image\/svg\+xml;base64,/u);
  assert.ok(html.includes('image.src = "frame-" + 3 + ".png";'));
  assert.ok(html.includes('link.href = "https://example.com/not-fetched";'));
});

test("unpinned or unsupported package URLs in scripts are refused with a reason", async () => {
  for (const script of [
    `import "https://cdn.jsdelivr.net/npm/three@latest/build/three.module.js";`,
    `fetch("https://cdn.jsdelivr.net/gh/user/repo@1.0.0/data.json");`,
    `import "https://cdn.jsdelivr.net/npm/three@0.170.0/+esm";`,
  ])
    await assert.rejects(
      sealed(
        `<html><body><script type="module">${script}</script></body></html>`,
      ),
      refusal(/pinned/u),
      script,
    );
  await assert.rejects(
    sealed(
      `<html><head><script src="https://example.com/a.js"></script></head><body></body></html>`,
    ),
    refusal(/pinned/u),
  );
});

test("a package stylesheet is inlined with its fonts and images", async () => {
  const base = "https://cdn.jsdelivr.net/npm/some-icons@2.0.1";
  const fetched: string[] = [];
  const { html } = await sealed(
    `<html><head><link rel="stylesheet" href="${base}/icons.css"></head><body></body></html>`,
    {},
    async (url) => {
      fetched.push(url);
      if (url.endsWith("icons.css"))
        return Buffer.from(
          `@font-face{font-family:I;src:url(./fonts/i.woff2) format("woff2"),url(./fonts/i.woff) format("woff")}.x{background:url("img/x.png")}`,
        );
      return Buffer.from("bytes");
    },
  );
  assert.deepEqual(fetched, [
    `${base}/icons.css`,
    `${base}/fonts/i.woff2`,
    `${base}/img/x.png`,
  ]);
  assert.match(html, /url\("data:font\/woff2;base64,/u);
  assert.match(html, /url\("data:image\/png;base64,/u);
  assert.doesNotMatch(html, /\.woff\)|cdn\.jsdelivr/u);
});
