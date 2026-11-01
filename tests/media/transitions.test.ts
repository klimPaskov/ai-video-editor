import assert from "node:assert/strict";
import test from "node:test";
import { assertGraphicContent } from "../../packages/domain/src/graphics.ts";
import {
  assertTransitionEffect,
  assertTransitionEffects,
  cutAt,
  nearestCut,
  transitionCuts,
  transitionGraphicIntervals,
  transitionIntervals,
  transitionKinds,
  transitionMarkup,
  type TransitionClip,
  type TransitionEffect,
} from "../../packages/domain/src/transitions.ts";

const dip: TransitionEffect = {
  transition_id: "transition-001",
  source_id: "source-a",
  source_us: 5_000_000,
  kind: "dip",
  duration_us: 600_000,
  color: "#000000",
};

// Three clips: 0-2 s and 5-8 s of source A (a cut at 2 s), then 0-1 s of
// source B (a second cut at 5 s). The A clip is split at 6 s with no jump.
const clips: TransitionClip[] = [
  {
    sourceId: "source-a",
    timelineStartUs: 0,
    timelineEndUs: 2_000_000,
    sourceStartUs: 0,
    sourceEndUs: 2_000_000,
  },
  {
    sourceId: "source-a",
    timelineStartUs: 2_000_000,
    timelineEndUs: 3_000_000,
    sourceStartUs: 5_000_000,
    sourceEndUs: 6_000_000,
  },
  {
    sourceId: "source-a",
    timelineStartUs: 3_000_000,
    timelineEndUs: 4_000_000,
    sourceStartUs: 6_000_000,
    sourceEndUs: 8_000_000,
    speed: 2,
  },
  {
    sourceId: "source-b",
    timelineStartUs: 4_000_000,
    timelineEndUs: 4_050_000,
    sourceStartUs: 0,
    sourceEndUs: 50_000,
  },
];

test("a transition has exact keys, a kind, a bounded duration and a #rrggbb colour", () => {
  assertTransitionEffect(dip);
  for (const kind of transitionKinds) assertTransitionEffect({ ...dip, kind });
  for (const bad of [
    { ...dip, kind: "spin" },
    { ...dip, duration_us: 100_000 },
    { ...dip, duration_us: 2_500_000 },
    { ...dip, color: "red" },
    { ...dip, color: "#12345" },
    { ...dip, source_us: -1 },
    { ...dip, transition_id: "x" },
    { ...dip, extra: true },
    { transition_id: dip.transition_id },
  ])
    assert.throws(() => assertTransitionEffect(bad), /Invalid transition/u);
});

test("transitions of a draft stay inside their sources, with one per cut", () => {
  const sources = [
    { source_id: "source-a", source_start_us: 0, source_end_us: 10_000_000 },
  ];
  assertTransitionEffects([dip], sources);
  assertTransitionEffects([], sources);
  for (const bad of [
    [{ ...dip, source_us: 10_000_000 }],
    [{ ...dip, source_id: "source-z" }],
    [dip, { ...dip, kind: "iris" as const }],
    [dip, { ...dip, transition_id: "transition-002" }],
  ])
    assert.throws(() => assertTransitionEffects(bad, sources));
});

test("only real cuts count: splits and speed changes of one stretch do not", () => {
  assert.deepEqual(
    transitionCuts(clips).map((cut) => [cut.atUs, cut.sourceId, cut.sourceUs]),
    [
      [2_000_000, "source-a", 5_000_000],
      [4_000_000, "source-b", 0],
    ],
  );
  assert.equal(cutAt(clips, 3_000_000), null);
  assert.equal(cutAt(clips, 2_000_000)?.sourceUs, 5_000_000);
  assert.equal(nearestCut(clips, 2_400_000)?.atUs, 2_000_000);
  assert.equal(nearestCut(clips, 3_900_000)?.atUs, 4_000_000);
  assert.equal(nearestCut(clips.slice(0, 1), 0), null);
});

test("a transition is centred on its cut and reaches into no third clip", () => {
  const [placed] = transitionIntervals([dip], clips, 4_050_000);
  assert.deepEqual(
    [placed!.startUs, placed!.cutUs, placed!.endUs],
    [1_700_000, 2_000_000, 2_300_000],
  );
  // Short clips on either side shrink the window symmetrically.
  const second = transitionIntervals(
    [
      {
        ...dip,
        transition_id: "transition-002",
        source_id: "source-b",
        source_us: 0,
        duration_us: 1_000_000,
      },
    ],
    clips,
    4_050_000,
  );
  assert.deepEqual(
    [second[0]!.startUs, second[0]!.endUs],
    [3_950_000, 4_050_000],
  );
  // A cut that is gone leaves the transition dormant, not an error.
  assert.deepEqual(
    transitionIntervals([dip], clips.slice(0, 1), 2_000_000),
    [],
  );
  assert.deepEqual(
    transitionIntervals([{ ...dip, source_us: 5_000_001 }], clips, 4_050_000),
    [],
  );
});

test("each kind draws safe, covering markup that peaks at the cut", () => {
  const [placed] = transitionIntervals([dip], clips, 4_050_000);
  for (const kind of transitionKinds) {
    const { html, css } = transitionMarkup({
      ...placed!,
      kind,
      color: "#1a73e8",
    });
    // Graphics reject anything but inline content; transitions must pass.
    assertGraphicContent(html, css);
    assert.match(css, /#1a73e8/u);
    // 0.6 s window, seeked from the transition's own start.
    assert.match(css, /0\.600000s/u);
    assert.match(css, /50%\{/u);
  }
  assert.match(transitionMarkup({ ...placed!, kind: "dip" }).css, /opacity:1/u);
  assert.match(
    transitionMarkup({ ...placed!, kind: "iris" }).css,
    /circle\(75%/u,
  );
  assert.match(
    transitionMarkup({ ...placed!, kind: "wipe_right" }).css,
    /translateX\(-110%\)/u,
  );
  assert.match(
    transitionMarkup({ ...placed!, kind: "wipe_left" }).css,
    /translateX\(110%\)/u,
  );
});

test("placed transitions become top-layer graphic intervals", () => {
  const graphics = transitionGraphicIntervals([dip], clips, 4_050_000);
  assert.equal(graphics.length, 1);
  assert.equal(graphics[0]!.graphicId, "transition-transition-001");
  assert.equal(graphics[0]!.layer, 100);
  assert.deepEqual(
    [graphics[0]!.startUs, graphics[0]!.endUs],
    [1_700_000, 2_300_000],
  );
});
