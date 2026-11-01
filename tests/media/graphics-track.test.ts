import assert from "node:assert/strict";
import test from "node:test";
import {
  graphicsSegments,
  unpremultiplyBgra,
} from "../../apps/desktop/src/graphics-track.ts";

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

test("a graphic that began before a one-frame window renders only that frame", () => {
  const graphic = (startUs: number, endUs: number) => ({
    graphicId: "g",
    name: "Graphic",
    startUs,
    endUs,
    layer: 1,
    html: "",
    css: "",
  });
  const rate = { numerator: 60, denominator: 1 };
  // A picture 40 s into a 53 s graphic: the window starts 40 s after it.
  assert.deepEqual(
    graphicsSegments([graphic(-40_000_000, 13_000_000)], rate, 1),
    [{ startFrame: 0, frameCount: 1 }],
  );
  // Entirely before or after the window: nothing to render.
  assert.deepEqual(
    graphicsSegments([graphic(-5_000_000, -1_000_000)], rate, 1),
    [],
  );
  assert.deepEqual(
    graphicsSegments([graphic(2_000_000, 3_000_000)], rate, 60),
    [],
  );
  // Inside an export: frames from its start to its end.
  assert.deepEqual(graphicsSegments([graphic(500_000, 1_000_000)], rate, 600), [
    { startFrame: 30, frameCount: 30 },
  ]);
});
