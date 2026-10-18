import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  importComposition,
  libraryRoute,
} from "../../apps/desktop/src/composition-import.ts";
import {
  compositionPolicy,
  serveComposition,
  storeComposition,
} from "../../apps/desktop/src/composition-server.ts";

const page = (body: string, head = "") => `<!doctype html>
<html><head>${head}<style>.t{background:url("bg.png")}</style></head>
<body><div id="root" data-composition-id="main" data-width="1920" data-height="1080" data-duration="4">${body}</div>
<script>window.__timelines["main"] = gsap.timeline({ paused: true });</script></body></html>`;

test("a composition is sealed: local files inline, pinned libraries local", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "composition-"));
  try {
    await mkdir(join(workspace, "compositions", "intro"), { recursive: true });
    const folder = join(workspace, "compositions", "intro");
    await writeFile(
      join(folder, "bg.png"),
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    );
    await writeFile(
      join(folder, "logo.svg"),
      "<svg xmlns='http://www.w3.org/2000/svg'/>",
    );
    await writeFile(
      join(folder, "motion.js"),
      "window.__made = true;</script>",
    );
    await writeFile(
      join(folder, "index.html"),
      page(
        '<img src="logo.svg">',
        '<script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script><script src="motion.js"></script>',
      ),
    );
    const sealed = await importComposition(
      workspace,
      "compositions/intro/index.html",
    );
    assert.match(sealed.sha256, /^[a-f0-9]{64}$/u);
    const html = sealed.html;
    // The runtime and bridge come first, then the pinned library, locally.
    assert.ok(
      html.indexOf("/lib/hyperframes-runtime.js") <
        html.indexOf("/lib/gsap@3.14.2/dist/gsap.min.js"),
    );
    assert.match(html, /\/lib\/stage-bridge\.js/u);
    assert.doesNotMatch(html, /cdn\.jsdelivr\.net/u);
    // Local files are inlined; a closing script tag in them cannot escape.
    assert.match(html, /<script>window\.__made = true;<\\\/script><\/script>/u);
    assert.match(html, /src="data:image\/svg\+xml;base64,/u);
    assert.match(html, /url\("data:image\/png;base64,/u);
    // Same content, same hash.
    assert.equal(
      (await importComposition(workspace, "compositions/intro/index.html"))
        .sha256,
      sealed.sha256,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("network, paths outside the workspace and non-compositions are refused", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "composition-"));
  try {
    const write = (name: string, content: string) =>
      writeFile(join(workspace, name), content);
    const refused = async (name: string, pattern: RegExp) =>
      assert.rejects(importComposition(workspace, name), (error: Error) => {
        assert.equal(error.name, "CompositionError");
        assert.match(error.message, pattern);
        return true;
      });
    await write("bg.png", "png");
    await write("plain.html", "<html><body><h1>Hi</h1></body></html>");
    await refused("plain.html", /data-composition-id/u);
    await write(
      "unpinned.html",
      page(
        "",
        '<script src="https://cdn.jsdelivr.net/npm/gsap@3/dist/gsap.min.js"></script>',
      ),
    );
    await refused("unpinned.html", /pinned/u);
    await write(
      "elsewhere.html",
      page("", '<script src="https://example.com/a.js"></script>'),
    );
    await refused("elsewhere.html", /pinned/u);
    await write(
      "font.html",
      page(
        "",
        '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">',
      ),
    );
    await refused("font.html", /network/u);
    await write("image.html", page('<img src="https://example.com/x.png">'));
    await refused("image.html", /network/u);
    await write("escape.html", page('<img src="../../etc/passwd.png">'));
    await refused("escape.html", /outside the workspace|not found/u);
    await refused("../outside.html", /outside the workspace|not found/u);
    await refused("notes.md", /\.html/u);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("only pinned allowlisted library files map to the local cache", () => {
  assert.equal(
    libraryRoute("https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"),
    "/lib/gsap@3.14.2/dist/gsap.min.js",
  );
  assert.equal(
    libraryRoute(
      "https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js",
    ),
    "/lib/three@0.170.0/build/three.module.js",
  );
  for (const url of [
    "https://cdn.jsdelivr.net/npm/gsap@latest/dist/gsap.min.js",
    "https://cdn.jsdelivr.net/npm/evil@1.0.0/x.js",
    "https://cdn.jsdelivr.net/npm/gsap@3.14.2/../../x.js",
    "http://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js",
    "https://unpkg.com/gsap@3.14.2/dist/gsap.min.js",
  ])
    assert.equal(libraryRoute(url), null, url);
});

test("the composition host serves sealed pages under a no-network policy", async () => {
  const root = await mkdtemp(join(tmpdir(), "composition-server-"));
  try {
    const sha = "a".repeat(64);
    await storeComposition(join(root, "pages"), sha, "<html>sealed</html>");
    const fetched: string[] = [];
    const options = {
      scheme: "ai-video-editor",
      compositions: join(root, "pages"),
      libraryCache: join(root, "cache"),
      packaged: {
        runtime: Buffer.from("runtime"),
        bridge: Buffer.from("bridge"),
      },
      fetchLibrary: async (url: string) => {
        fetched.push(url);
        return Buffer.from("library");
      },
    };
    const response = await serveComposition(`/${sha}.html`, options);
    assert.equal(await response.text(), "<html>sealed</html>");
    const policy = response.headers.get("Content-Security-Policy")!;
    assert.equal(policy, compositionPolicy("ai-video-editor"));
    assert.match(policy, /connect-src 'none'/u);
    assert.match(
      policy,
      /script-src ai-video-editor:\/\/composition 'unsafe-inline'/u,
    );
    assert.doesNotMatch(policy, /https?:/u);
    assert.equal(
      await (await serveComposition("/lib/stage-bridge.js", options)).text(),
      "bridge",
    );
    // A pinned library is fetched once, then served from the cache.
    for (let index = 0; index < 2; index++)
      assert.equal(
        await (
          await serveComposition("/lib/gsap@3.14.2/dist/gsap.min.js", options)
        ).text(),
        "library",
      );
    assert.deepEqual(fetched, [
      "https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js",
    ]);
    for (const path of [
      "/lib/evil@1.0.0/x.js",
      "/lib/gsap@3.14.2/../x.js",
      `/${"b".repeat(64)}.html`,
      "/index.html",
    ])
      assert.equal((await serveComposition(path, options)).status, 404, path);
    assert.equal(fetched.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
