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

test("exactly pinned package files and directories map to the local cache", () => {
  for (const [url, route] of [
    [
      "https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js",
      "/lib/gsap@3.14.2/dist/gsap.min.js",
    ],
    [
      "https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js",
      "/lib/three@0.170.0/build/three.module.js",
    ],
    // Any package, scoped ones too, and prerelease versions.
    [
      "https://cdn.jsdelivr.net/npm/@dimforge/rapier3d-compat@0.14.0/rapier.es.js",
      "/lib/@dimforge/rapier3d-compat@0.14.0/rapier.es.js",
    ],
    [
      "https://cdn.jsdelivr.net/npm/pixi.js@8.0.0-rc.1/dist/pixi.min.mjs",
      "/lib/pixi.js@8.0.0-rc.1/dist/pixi.min.mjs",
    ],
    // An import map prefix is a directory of a pinned package.
    [
      "https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/",
      "/lib/three@0.170.0/examples/jsm/",
    ],
  ] as const)
    assert.equal(libraryRoute(url), route, url);
  for (const url of [
    "https://cdn.jsdelivr.net/npm/gsap@latest/dist/gsap.min.js",
    "https://cdn.jsdelivr.net/npm/gsap@3/dist/gsap.min.js",
    "https://cdn.jsdelivr.net/npm/gsap/dist/gsap.min.js",
    "https://cdn.jsdelivr.net/npm/gsap@3.14.2/../../x.js",
    "https://cdn.jsdelivr.net/npm/three@0.170.0/../examples/",
    "https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/install.sh",
    "https://cdn.jsdelivr.net/gh/user/repo@1.0.0/x.js",
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
    // No network: a page may fetch only this host's pinned files and
    // data/blob URLs; scripts are inline or from this host (modules and
    // WebAssembly included).
    assert.match(
      policy,
      /connect-src ai-video-editor:\/\/composition data: blob:/u,
    );
    assert.match(
      policy,
      /script-src ai-video-editor:\/\/composition 'unsafe-inline' 'wasm-unsafe-eval'/u,
    );
    assert.match(policy, /default-src 'none'/u);
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
    // Any pinned package file, with its own content type, and CORS for the
    // sandboxed frame's module and fetch requests.
    for (const [path, type] of [
      ["/lib/three@0.170.0/build/three.module.js", "text/javascript"],
      ["/lib/pixi.js@8.0.0/dist/pixi.min.mjs", "text/javascript"],
      ["/lib/@dimforge/rapier3d-compat@0.14.0/rapier.wasm", "application/wasm"],
      ["/lib/pkg@1.2.3/data/model.glb", "model/gltf-binary"],
      ["/lib/pkg@1.2.3/data/table.json", "application/json"],
    ] as const) {
      const served = await serveComposition(path, options);
      assert.equal(served.status, 200, path);
      assert.match(served.headers.get("Content-Type")!, new RegExp(type), path);
      assert.equal(served.headers.get("Access-Control-Allow-Origin"), "*");
    }
    for (const path of [
      "/lib/gsap@3.14.2/../x.js",
      "/lib/gsap@latest/dist/gsap.min.js",
      "/lib/gsap@3.14.2/dist/install.sh",
      "/lib/gsap@3.14.2/dist/",
      `/${"b".repeat(64)}.html`,
      "/index.html",
    ])
      assert.equal((await serveComposition(path, options)).status, 404, path);
    // Only the exact pinned URLs were fetched.
    assert.equal(
      fetched.every((url) =>
        /^https:\/\/cdn\.jsdelivr\.net\/npm\/[^/]+(\/[^/]+)?@[0-9][^/]*\/[A-Za-z0-9._/-]+$/u.test(
          url,
        ),
      ),
      true,
    );
    assert.equal(fetched.length, 6);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pinned Fontsource fonts are fetched once and inlined; other fonts are refused", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "composition-"));
  try {
    const folder = join(workspace, "compositions", "type");
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "bg.png"), Buffer.from([0x89, 0x50]));
    const base = "https://cdn.jsdelivr.net/npm/@fontsource/inter@5.2.8";
    const fetched: string[] = [];
    const fetchPackage = async (url: string) => {
      fetched.push(url);
      if (url === `${base}/latin-700.css`)
        return Buffer.from(
          `/* inter-latin-700-normal */
@font-face {
  font-family: 'Inter';
  font-weight: 700;
  src: url(./files/inter-latin-700-normal.woff2) format('woff2'), url(./files/inter-latin-700-normal.woff) format('woff');
}`,
        );
      if (url === `${base}/files/inter-latin-700-normal.woff2`)
        return Buffer.from("wOF2-bytes");
      if (url.endsWith("/display.woff2")) return Buffer.from("wOF2-display");
      throw new Error("missing");
    };
    await writeFile(
      join(folder, "index.html"),
      page(
        "<h1>Title</h1>",
        `<link rel="preconnect" href="https://fonts.gstatic.com"><link rel="stylesheet" href="${base}/latin-700.css"><style>@font-face{font-family:D;src:url("https://cdn.jsdelivr.net/npm/@fontsource-variable/fraunces@5.2.8/files/display.woff2") format("woff2")}</style>`,
      ),
    );
    const { html } = await importComposition(
      workspace,
      "compositions/type/index.html",
      { fetchPackage },
    );
    // The stylesheet and its woff2 are inlined; the woff fallback is dropped.
    assert.deepEqual(fetched, [
      `${base}/latin-700.css`,
      `${base}/files/inter-latin-700-normal.woff2`,
      "https://cdn.jsdelivr.net/npm/@fontsource-variable/fraunces@5.2.8/files/display.woff2",
    ]);
    assert.ok(
      html.includes(
        `src: url("data:font/woff2;base64,${Buffer.from("wOF2-bytes").toString("base64")}") format('woff2');`,
      ),
    );

    assert.doesNotMatch(html, /\.woff\)|cdn\.jsdelivr|fonts\.gstatic/u);
    assert.match(html, /font-family: 'Inter'/u);

    // Google Fonts, unpinned versions, other CDNs and missing files are refused.
    for (const [head, reason] of [
      [
        '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">',
        /pinned npm package files/u,
      ],
      [
        '<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@fontsource/inter@5/700.css">',
        /pinned npm package files/u,
      ],
      [
        '<style>@font-face{font-family:X;src:url("https://example.com/x.woff2")}</style>',
        /from the network/u,
      ],
      [
        '<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@fontsource/inter@5.2.8/missing.css">',
        /could not be downloaded/u,
      ],
    ] as const) {
      await writeFile(join(folder, "index.html"), page("<h1>T</h1>", head));
      await assert.rejects(
        importComposition(workspace, "compositions/type/index.html", {
          fetchPackage,
        }),
        (error: Error) =>
          error.name === "CompositionError" && reason.test(error.message),
      );
    }
    // Without a fetcher, a font package cannot be sealed.
    await writeFile(
      join(folder, "index.html"),
      page(
        "<h1>T</h1>",
        `<link rel="stylesheet" href="${base}/latin-700.css">`,
      ),
    );
    await assert.rejects(
      importComposition(workspace, "compositions/type/index.html"),
      /cannot be fetched/u,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
