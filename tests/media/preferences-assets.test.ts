import assert from "node:assert/strict";
import test from "node:test";
import {
  assertPreferences,
  effectiveAssetPolicy,
} from "../../packages/domain/src/preferences.ts";

test("Claude may use any material unless the user limits it", () => {
  // Earlier settings files have no choice: any material.
  const earlier = { interfaceScale: 1 as const };
  assertPreferences(earlier);
  assert.equal(effectiveAssetPolicy(earlier), "any");
  for (const assetPolicy of ["any", "copyright_free"] as const) {
    const value = { interfaceScale: 1.25 as const, assetPolicy };
    assertPreferences(value);
    assert.equal(effectiveAssetPolicy(value), assetPolicy);
  }
  for (const wrong of [
    { interfaceScale: 1, assetPolicy: "none" },
    { interfaceScale: 1, assetPolicy: null },
    { interfaceScale: 1, path: "/private" },
    { assetPolicy: "any" },
  ])
    assert.throws(() => assertPreferences(wrong));
});

test("the settings file keeps the material choice", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { PreferencesStore } =
    await import("../../apps/desktop/src/preferences.ts");
  const root = await mkdtemp(join(tmpdir(), "preferences-assets-"));
  try {
    const store = new PreferencesStore(root);
    await store.write({ interfaceScale: 1.5, assetPolicy: "copyright_free" });
    assert.deepEqual(await new PreferencesStore(root).read(), {
      interfaceScale: 1.5,
      assetPolicy: "copyright_free",
    });
    await store.write({ interfaceScale: 1 });
    assert.deepEqual(await store.read(), { interfaceScale: 1 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
