import assert from "node:assert/strict";
import test from "node:test";
import { unpremultiplyBgra } from "../../apps/desktop/src/graphics-track.ts";

test("premultiplied captures become straight alpha without touching opaque or empty pixels", () => {
  const bitmap = Buffer.from([
    // opaque: unchanged
    10, 200, 255, 255,
    // transparent: colour cleared
    7, 8, 9, 0,
    // half alpha: colour scaled back up
    64, 32, 128, 128,
    // tiny alpha: clamped to 255
    2, 1, 0, 1,
  ]);
  assert.deepEqual(
    [...unpremultiplyBgra(bitmap)],
    [10, 200, 255, 255, 0, 0, 0, 0, 128, 64, 255, 128, 255, 255, 0, 1],
  );
  assert.throws(() => unpremultiplyBgra(Buffer.alloc(3)));
});
