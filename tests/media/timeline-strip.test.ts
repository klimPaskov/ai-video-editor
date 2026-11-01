import assert from "node:assert/strict";
import test from "node:test";
import {
  assertProjectStripRequest,
  assertProjectStripResult,
  maxStripFrames,
} from "../../packages/domain/src/project-view.ts";
import {
  rulerLabel,
  rulerTicks,
  stripCellTimes,
} from "../../packages/domain/src/timeline-strip.ts";

test("filmstrip cells sit at the centres of equal parts of the edit", () => {
  assert.deepEqual(
    stripCellTimes(10_000_000, 264, 88),
    [1_666_666, 5_000_000, 8_333_333],
  );
  // Always at least one cell; never past the end; strictly increasing.
  assert.deepEqual(stripCellTimes(5_000_000, 10), [2_500_000]);
  const many = stripCellTimes(3_600_000_000, 100_000);
  assert.equal(many.length, maxStripFrames);
  for (const [index, time] of many.entries()) {
    assert.ok(time >= 0 && time < 3_600_000_000);
    if (index > 0) assert.ok(time > many[index - 1]!);
  }
  // A very short edit cannot repeat a time.
  const tiny = stripCellTimes(3, 880, 88);
  assert.deepEqual(
    tiny,
    [...new Set(tiny)].sort((a, b) => a - b),
  );
  assert.deepEqual(stripCellTimes(0, 500), []);
  assert.deepEqual(stripCellTimes(5_000_000, 0), []);
});

test("ruler labels are minutes and seconds, with hours from an hour", () => {
  assert.equal(rulerLabel(0), "0:00");
  assert.equal(rulerLabel(65_000_000), "1:05");
  assert.equal(rulerLabel(3_599_000_000), "59:59");
  assert.equal(rulerLabel(3_725_000_000), "1:02:05");
});

test("ruler ticks use the finest whole-second step that keeps labels apart", () => {
  // 60 s over 600 px: one label per 7.2 s would fit, so the step is 10 s.
  const ticks = rulerTicks(60_000_000, 600);
  assert.deepEqual(
    ticks.map((tick) => tick.label),
    ["0:00", "0:10", "0:20", "0:30", "0:40", "0:50", "1:00"],
  );
  assert.equal(ticks[0]!.us, 0);
  assert.equal(ticks.at(-1)!.us, 60_000_000);
  // Narrower strips take a coarser step; no tick passes the end.
  const narrow = rulerTicks(60_000_000, 200);
  assert.ok(narrow.length < ticks.length);
  assert.ok(narrow.every((tick) => tick.us <= 60_000_000));
  // Labels stay apart at any width.
  for (const width of [150, 400, 1000, 2400])
    for (const duration of [4_000_000, 90_000_000, 900_000_000]) {
      const set = rulerTicks(duration, width);
      for (let index = 1; index < set.length; index++)
        assert.ok(
          ((set[index]!.us - set[index - 1]!.us) / duration) * width >= 72 ||
            set.length <= 2,
          `${duration} at ${width}`,
        );
    }
  assert.deepEqual(rulerTicks(0, 600), []);
});

const head = {
  projectId: "8a9c7a44-5e4f-4c5e-9d2e-5c1f0b2a7e11",
  draftId: "draft-1",
  baseRevisionId: "1b2c3d4e-5f60-4a71-8b92-a3b4c5d6e7f8",
  expectedSequence: 3,
  expectedTimelineSha256: "a".repeat(64),
};

test("a strip request has increasing times, a bounded count and exact keys", () => {
  assertProjectStripRequest({ ...head, timesUs: [0, 10, 20] });
  for (const bad of [
    { ...head, timesUs: [] },
    { ...head, timesUs: [5, 5] },
    { ...head, timesUs: [9, 3] },
    { ...head, timesUs: [-1] },
    { ...head, timesUs: [1.5] },
    { ...head, timesUs: Array.from({ length: 33 }, (_, i) => i) },
    { ...head, timesUs: [1], path: "/tmp/x" },
    { ...head, draftId: head.projectId, timesUs: [1] },
  ])
    assert.throws(() => assertProjectStripRequest(bad));
});

test("a strip result carries small pictures or none and nothing else", () => {
  const ready = {
    status: "ready",
    projectId: head.projectId,
    draftId: head.draftId,
    baseRevisionId: head.baseRevisionId,
    draftSequence: 3,
    timelineSha256: "a".repeat(64),
    frames: [
      {
        timelineTimeUs: 0,
        frame: { width: 2, height: 2, rgbaBase64: "AAAAAAAAAAAAAAAAAAAAAA==" },
      },
      { timelineTimeUs: 100, frame: null },
    ],
  };
  assertProjectStripResult(ready);
  for (const bad of [
    { ...ready, frames: [{ timelineTimeUs: 0 }] },
    {
      ...ready,
      frames: [
        {
          timelineTimeUs: 0,
          frame: { width: 400, height: 2, rgbaBase64: "AA==" },
        },
      ],
    },
    { ...ready, source: "/video.mkv" },
    { ...ready, status: "pending" },
  ])
    assert.throws(() => assertProjectStripResult(bad));
});
