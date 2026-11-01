import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type * as FuseModule from "../../scripts/fuses.ts";
async function load(): Promise<typeof FuseModule | null> {
  try {
    return await import("../../scripts/fuses.ts");
  } catch {
    return null;
  }
}

const sentinel = "dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX";
// Electron's stock wire: RunAsNode, CookieEncryption, NodeOptions, NodeCliInspect,
// AsarIntegrity, OnlyLoadAppFromAsar, V8Snapshot, FileProtocol, WasmTrapHandlers.
const stockWire = "101100011";

const expected = {
  RunAsNode: "enabled",
  EnableNodeOptionsEnvironmentVariable: "disabled",
  EnableNodeCliInspectArguments: "disabled",
  EnableEmbeddedAsarIntegrityValidation: "enabled",
  OnlyLoadAppFromAsar: "enabled",
  GrantFileProtocolExtraPrivileges: "disabled",
};

test("release fuses turn off inspector, NODE_OPTIONS and file privileges, enforce the asar, and keep RunAsNode", async (context) => {
  const fuses = await load();
  if (!fuses) return context.skip("@electron/fuses is not installed");
  const directory = await mkdtemp(join(tmpdir(), "fuse-"));
  try {
    const binary = join(directory, "electron");
    const padding = Buffer.alloc(5000, 0x41);
    await writeFile(
      binary,
      Buffer.concat([
        padding,
        Buffer.from(sentinel),
        Buffer.from([1, 9]),
        Buffer.from(stockWire),
        padding,
      ]),
    );
    const before = await fuses.readFuses(binary);
    assert.equal(before.EnableNodeCliInspectArguments, "enabled");
    assert.equal(before.RunAsNode, "enabled");
    const after = await fuses.applyReleaseFuses(binary);
    for (const [name, state] of Object.entries(expected))
      assert.equal(after[name], state, name);
    assert.deepEqual(fuses.expectedReleaseFuses(), expected);
    // Fuses the policy does not mention keep Electron's own value, and the
    // rest of the binary is untouched.
    assert.equal(after.EnableCookieEncryption, before.EnableCookieEncryption);
    assert.equal(after.WasmTrapHandlers, before.WasmTrapHandlers);
    const bytes = await readFile(binary);
    assert.equal(bytes.length, padding.length * 2 + 32 + 2 + 9);
    assert.deepEqual(bytes.subarray(0, 5000), padding);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a release-built package carries the release fuses", async (context) => {
  const fuses = await load();
  const path = process.env.AI_VIDEO_EDITOR_RELEASE_PACKAGE;
  if (!fuses || !path)
    return context.skip(
      "set AI_VIDEO_EDITOR_RELEASE_PACKAGE to a --release build's Electron executable",
    );
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(await fuses.readFuses(path)).filter(
        ([name]) => name in expected,
      ),
    ),
    expected,
  );
});

test("a development build keeps the inspector available for Playwright", async (context) => {
  const fuses = await load();
  const path = process.env.AI_VIDEO_EDITOR_DEV_PACKAGE;
  if (!fuses || !path)
    return context.skip(
      "set AI_VIDEO_EDITOR_DEV_PACKAGE to a default build's Electron executable",
    );
  const state = await fuses.readFuses(path);
  assert.equal(state.EnableNodeCliInspectArguments, "enabled");
  assert.equal(state.RunAsNode, "enabled");
});
