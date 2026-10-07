import assert from "node:assert/strict";
import test from "node:test";
import { captionWordsForDraft } from "../../packages/domain/src/captions.ts";
import { draftWindowClips } from "../../packages/domain/src/short-clips.ts";
import {
  atempoChain,
  isClipSpeed,
  sourceAt,
  speedLength,
  timelineAt,
} from "../../packages/domain/src/speed.ts";
import { zoomIntervals } from "../../packages/domain/src/zoom.ts";

const clip = {
  source_start_us: 1_000_000,
  source_end_us: 2_500_000,
  timeline_start_us: 400_000,
  speed: 3,
};
// Output view of: 0–1 s normal, then source 1–2.5 s at 3× (0.5 s).
const views = [
  {
    sourceId: "source-a",
    timelineStartUs: 0,
    timelineEndUs: 1_000_000,
    sourceStartUs: 0,
    sourceEndUs: 1_000_000,
  },
  {
    sourceId: "source-a",
    timelineStartUs: 1_000_000,
    timelineEndUs: 1_500_000,
    sourceStartUs: 1_000_000,
    sourceEndUs: 2_500_000,
    speed: 3,
  },
];

test("speeds are whole numbers that map output and source time exactly", () => {
  assert.ok([1, 2, 3, 4, 8].every(isClipSpeed));
  assert.ok(![0, 1.5, 5, 16, "2", null].some(isClipSpeed));
  assert.equal(speedLength(1_500_000, 3), 500_000);
  assert.equal(speedLength(1_000_001, 2), 500_001);
  assert.equal(sourceAt(clip, 400_000), 1_000_000);
  assert.equal(sourceAt(clip, 500_000), 1_300_000);
  assert.equal(timelineAt(clip, 1_300_000), 500_000);
  const normal = {
    source_start_us: clip.source_start_us,
    source_end_us: clip.source_end_us,
    timeline_start_us: clip.timeline_start_us,
  };
  assert.equal(sourceAt(normal, 500_000), 1_100_000);
  assert.equal(atempoChain(1), "");
  assert.equal(atempoChain(2), "atempo=2");
  assert.equal(atempoChain(3), "atempo=2,atempo=1.5");
  assert.equal(atempoChain(8), "atempo=2,atempo=2,atempo=2");
});

test("captions, zooms and short windows follow sped-up clips", () => {
  const words = captionWordsForDraft(
    [
      {
        sourceId: "source-a",
        text: "before",
        startUs: 200_000,
        endUs: 500_000,
      },
      {
        sourceId: "source-a",
        text: "fast",
        startUs: 1_300_000,
        endUs: 1_900_000,
      },
    ],
    views,
  );
  assert.deepEqual(
    words.map((word) => [word.text, word.startUs, word.endUs]),
    [
      ["before", 200_000, 500_000],
      ["fast", 1_100_000, 1_300_000],
    ],
  );
  const pieces = zoomIntervals(
    [
      {
        zoom_id: "zoom-1",
        source_id: "source-a",
        source_start_us: 700_000,
        source_end_us: 1_600_000,
        center_x: 0.5,
        center_y: 0.5,
        scale: 2,
      },
    ],
    views,
  );
  assert.deepEqual(
    pieces.map((piece) => [piece.startUs, piece.endUs]),
    [
      [700_000, 1_000_000],
      [1_000_000, 1_200_000],
    ],
  );
  assert.deepEqual(draftWindowClips(views, 800_000, 1_500_000), [
    { sourceId: "source-a", sourceStartUs: 800_000, sourceEndUs: 1_000_000 },
    {
      sourceId: "source-a",
      sourceStartUs: 1_000_000,
      sourceEndUs: 2_500_000,
      speed: 3,
    },
  ]);
  assert.deepEqual(draftWindowClips(views, 1_100_000, 1_200_000), [
    {
      sourceId: "source-a",
      sourceStartUs: 1_300_000,
      sourceEndUs: 1_600_000,
      speed: 3,
    },
  ]);
});
