import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PreferencesStore } from "../../apps/desktop/src/preferences.ts";
import { assertPreferences } from "../../packages/domain/src/preferences.ts";
import {
  assertThemeChoice,
  contrastRatio,
  customThemeProblem,
  onAccent,
  themeIds,
  themeLayout,
  type CustomTheme,
} from "../../packages/domain/src/theme.ts";

const custom: CustomTheme = {
  background: "#101820",
  surface: "#1b2733",
  text: "#f4f7fa",
  accent: "#ff8a3d",
  layout: "cinematic",
};

test("a theme is one of the listed ids, with colours only for Custom", () => {
  for (const id of themeIds.filter((item) => item !== "custom"))
    assertThemeChoice({ id });
  assertThemeChoice({ id: "custom", custom });
  for (const wrong of [
    null,
    {},
    { id: "neon" },
    { id: "light_canvas", custom },
    { id: "custom" },
    { id: "custom", custom: { ...custom, accent: "red" } },
    { id: "custom", custom: { ...custom, accent: "#FF8A3D" } },
    { id: "custom", custom: { ...custom, layout: "wide" } },
    { id: "custom", custom: { ...custom, extra: 1 } },
    { id: "custom", custom: { ...custom, background: "url(x)" } },
    { id: "light_canvas", extra: 1 },
  ])
    assert.throws(() => assertThemeChoice(wrong), /./u, JSON.stringify(wrong));
});

test("unreadable custom colours are refused with a reason", () => {
  assert.equal(customThemeProblem(custom), null);
  assert.match(
    customThemeProblem({ ...custom, text: "#202a33" }) ?? "",
    /text colour is too close to the background/u,
  );
  assert.match(
    customThemeProblem({
      ...custom,
      background: "#ffffff",
      surface: "#101820",
      text: "#202a33",
    }) ?? "",
    /too close to the card colour/u,
  );
  assert.match(
    customThemeProblem({ ...custom, accent: "#101820" }) ?? "",
    /accent is too close/u,
  );
  assert.throws(
    () =>
      assertThemeChoice({
        id: "custom",
        custom: { ...custom, text: "#202a33" },
      }),
    /too close/u,
  );
});

test("Cinematic and a Cinematic custom theme change the layout", () => {
  assert.equal(themeLayout({ id: "light_canvas" }), "classic");
  assert.equal(themeLayout({ id: "cinematic" }), "cinematic");
  assert.equal(themeLayout({ id: "custom", custom }), "cinematic");
  assert.equal(
    themeLayout({ id: "custom", custom: { ...custom, layout: "classic" } }),
    "classic",
  );
  assert.equal(onAccent("#ffffff"), "#111111");
  assert.equal(onAccent("#1a6dff"), "#ffffff");
});

test("the theme is kept with the other settings and stays small", async () => {
  const preferences = {
    interfaceScale: 1.25 as const,
    assetPolicy: "copyright_free" as const,
    theme: { id: "custom" as const, custom },
  };
  assertPreferences(preferences);
  assert.throws(() =>
    assertPreferences({ interfaceScale: 1, theme: { id: "neon" } }),
  );
  const root = await mkdtemp(join(tmpdir(), "theme-prefs-"));
  try {
    await new PreferencesStore(root).write(preferences);
    assert.deepEqual(await new PreferencesStore(root).read(), preferences);
    const stored = await readFile(join(root, "preferences.json"), "utf8");
    assert.ok(stored.length < 1024, `${stored.length} bytes`);
    // A file without a theme still reads: Light Canvas applies.
    await new PreferencesStore(root).write({ interfaceScale: 1 });
    assert.deepEqual(await new PreferencesStore(root).read(), {
      interfaceScale: 1,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/** The built-in palettes, read from the style sheet that ships. */
async function palettes(): Promise<Map<string, Map<string, string>>> {
  const css = await readFile(
    new URL("../../apps/desktop/renderer/style.css", import.meta.url),
    "utf8",
  );
  const result = new Map<string, Map<string, string>>();
  const blocks = css.matchAll(
    /(?:^|\n):root(?:\[data-theme="([a-z_]+)"\])?\s*\{([^}]*)\}/gu,
  );
  for (const block of blocks) {
    const name = block[1] ?? "light_canvas";
    const values = result.get(name) ?? new Map<string, string>();
    for (const line of block[2]!.matchAll(
      /(--[a-z0-9-]+):\s*(#[0-9a-f]{6});/gu,
    ))
      values.set(line[1]!, line[2]!);
    result.set(name, values);
  }
  return result;
}

test("every built-in palette keeps its text readable", async () => {
  const all = await palettes();
  const base = all.get("light_canvas")!;
  for (const id of ["light_canvas", "studio_dark", "paper", "cinematic"]) {
    const own = all.get(id);
    assert.ok(own, `${id} is defined in the style sheet`);
    const get = (name: string) => own.get(name) ?? base.get(name)!;
    const checks: Array<[string, string, string, number]> = [
      ["--text", "--bg", "text on the background", 7],
      ["--text", "--surface", "text on cards", 7],
      ["--text-2", "--bg", "secondary text on the background", 4.5],
      ["--text-2", "--surface", "secondary text on cards", 4.5],
      ["--text-3", "--bg", "quiet text on the background", 4.5],
      ["--text-3", "--surface", "quiet text on cards", 4.5],
      ["--accent-text", "--surface", "accent text on cards", 4.5],
      ["--accent-text", "--bg", "accent text on the background", 4.5],
      ["--on-accent", "--accent", "button text on the accent", 4.5],
      ["--danger-text", "--surface", "error text on cards", 4.5],
      ["--clip-text", "--clip", "timeline label on a clip", 4.5],
    ];
    for (const [front, back, what, minimum] of checks) {
      const ratio = contrastRatio(get(front), get(back));
      assert.ok(
        ratio >= minimum,
        `${id}: ${what} is ${ratio.toFixed(2)}:1, needs ${minimum}:1`,
      );
    }
  }
});
