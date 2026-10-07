import assert from "node:assert/strict";
import test from "node:test";
import {
  assertGraphicContent,
  assertGraphicEffect,
  assertGraphicEffects,
  GraphicContentError,
  graphicAnchor,
  graphicIntervals,
  graphicsAt,
  type GraphicEffect,
} from "../../packages/domain/src/graphics.ts";

const title: GraphicEffect = {
  graphic_id: "graphic-title",
  name: "Title card",
  source_id: "source-a",
  source_us: 1_000_000,
  duration_us: 3_000_000,
  layer: 1,
  html: '<div class="title"><svg viewBox="0 0 10 10"><use href="#dot"/></svg>Weekly review</div>',
  css: ".title { animation: rise 600ms ease-out both; background: url(data:image/png;base64,AAAA) } @keyframes rise { from { opacity: 0 } }",
};

test("graphics accept inline HTML, CSS and data images only", () => {
  assertGraphicEffect(title);
  assertGraphicEffects(
    [title],
    [{ source_id: "source-a", source_start_us: 0, source_end_us: 10_000_000 }],
  );
  for (const [html, css] of [
    ["<script>alert(1)</script>", ""],
    ["<SCRIPT src=x></SCRIPT>", ""],
    ['<img src="https://example.com/a.png">', ""],
    ['<img src=x onerror="alert(1)">', ""],
    ['<a href="javascript:alert(1)">x</a>', ""],
    ['<a href="java&#58;script:1">x</a>', ""],
    ["<iframe></iframe>", ""],
    ['<link rel="stylesheet" href="a.css">', ""],
    ["<video></video>", ""],
    ["", "@import 'x.css';"],
    ["", ".a { background: url(https://example.com/x.png) }"],
    ["", ".a { background: url(/etc/passwd) }"],
    ["", "</style><script>1</script>"],
  ])
    assert.throws(
      () => assertGraphicContent(html!, css!),
      GraphicContentError,
      `${html}${css}`,
    );
  for (const bad of [
    { ...title, duration_us: 10 },
    { ...title, layer: 100 },
    { ...title, name: "" },
    { ...title, html: "x".repeat(70_000) },
    { ...title, extra: true },
    { ...title, html: "<script></script>" },
  ])
    assert.throws(() => assertGraphicEffect(bad));
  assert.throws(() =>
    assertGraphicEffects(
      [title, title],
      [
        {
          source_id: "source-a",
          source_start_us: 0,
          source_end_us: 10_000_000,
        },
      ],
    ),
  );
  assert.throws(() =>
    assertGraphicEffects(
      [{ ...title, source_us: 20_000_000 }],
      [
        {
          source_id: "source-a",
          source_start_us: 0,
          source_end_us: 10_000_000,
        },
      ],
    ),
  );
});

test("graphics follow cuts and speed, and hide when their moment is cut", () => {
  const clips = [
    {
      sourceId: "source-a",
      timelineStartUs: 0,
      timelineEndUs: 500_000,
      sourceStartUs: 500_000,
      sourceEndUs: 1_000_000,
    },
    {
      sourceId: "source-a",
      timelineStartUs: 500_000,
      timelineEndUs: 1_500_000,
      sourceStartUs: 1_000_000,
      sourceEndUs: 3_000_000,
      speed: 2,
    },
  ];
  const lower = {
    ...title,
    graphic_id: "graphic-lower",
    name: "Lower third",
    source_us: 2_000_000,
    duration_us: 2_000_000,
    layer: 0,
  };
  const gone = { ...title, graphic_id: "graphic-gone", source_us: 200_000 };
  const placed = graphicIntervals([title, lower, gone], clips, 1_500_000);
  assert.deepEqual(
    placed.map((item) => [item.graphicId, item.startUs, item.endUs]),
    [
      ["graphic-title", 500_000, 1_500_000],
      ["graphic-lower", 1_000_000, 1_500_000],
    ],
  );
  assert.deepEqual(
    graphicsAt(placed, 1_200_000).map((item) => item.graphicId),
    ["graphic-lower", "graphic-title"],
  );
  assert.deepEqual(graphicsAt(placed, 400_000), []);
  assert.deepEqual(
    graphicAnchor(
      [
        {
          source_id: "source-a",
          source_start_us: 1_000_000,
          source_end_us: 3_000_000,
          timeline_start_us: 500_000,
          timeline_end_us: 1_500_000,
          speed: 2,
        },
      ],
      700_000,
    ),
    { source_id: "source-a", source_us: 1_400_000 },
  );
});
