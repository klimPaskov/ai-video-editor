import assert from "node:assert/strict";
import test from "node:test";
import { assertGraphicContent } from "../../packages/domain/src/graphics.ts";
import {
  GraphicComponentError,
  graphicComponentKinds,
  renderGraphicComponent,
} from "../../packages/domain/src/graphic-components.ts";

test("every component renders safe content with its text, accent and an exit", () => {
  for (const kind of graphicComponentKinds) {
    const rendered = renderGraphicComponent(
      kind,
      {
        title: kind === "step_badge" ? "Open the menu" : "Sample & title",
        subtitle: kind === "step_badge" ? "3" : "A second line",
        accent: "#22c55e",
        x: 0.2,
        y: 0.3,
        width: 0.3,
        height: 0.2,
      },
      3_000_000,
    );
    // The same validator every graphic goes through.
    assertGraphicContent(rendered.html, rendered.css);
    assert.ok(rendered.name.length > 0 && rendered.name.length <= 80);
    assert.ok(rendered.css.includes("#22c55e"));
    assert.ok(rendered.css.includes("gc-exit"));
    assert.ok(
      rendered.css.includes("2.550s"),
      "exit starts 0.45 s before the end",
    );
    assert.ok(
      !/<script|javascript:|https?:/iu.test(rendered.html + rendered.css),
    );
  }
});

test("text is escaped and bad input is refused with a reason", () => {
  const rendered = renderGraphicComponent(
    "keyword",
    { title: '<img src=x onerror=1>"' },
    2_000_000,
  );
  assert.ok(!rendered.html.includes("<img"));
  assert.ok(rendered.html.includes("&lt;img"));
  for (const bad of [
    () => renderGraphicComponent("lower_third", { title: "" }, 2_000_000),
    () =>
      renderGraphicComponent(
        "lower_third",
        { title: "x".repeat(61) },
        2_000_000,
      ),
    () => renderGraphicComponent("lower_third", { title: "ok" }, 1_000_000),
    () =>
      renderGraphicComponent(
        "lower_third",
        { title: "ok", accent: "red" },
        2_000_000,
      ),
    () => renderGraphicComponent("highlight_box", { title: "ok" }, 2_000_000),
    () =>
      renderGraphicComponent(
        "highlight_box",
        { title: "ok", x: 0.8, y: 0.1, width: 0.4, height: 0.2 },
        2_000_000,
      ),
    () =>
      renderGraphicComponent(
        "step_badge",
        { title: "ok", subtitle: "x" },
        2_000_000,
      ),
  ])
    assert.throws(bad, GraphicComponentError);
});

test("sides and places move a component without changing its content", () => {
  const left = renderGraphicComponent(
    "stat_callout",
    { title: "42%", subtitle: "faster", side: "left", place: "top" },
    2_000_000,
  );
  const right = renderGraphicComponent(
    "stat_callout",
    { title: "42%", subtitle: "faster", side: "right", place: "bottom" },
    2_000_000,
  );
  assert.equal(left.html, right.html);
  assert.notEqual(left.css, right.css);
  assert.ok(left.css.includes("left:7cqw") && left.css.includes("top:9cqh"));
  assert.ok(
    right.css.includes("right:7cqw") && right.css.includes("bottom:10cqh"),
  );
});
