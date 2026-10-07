import assert from "node:assert/strict";
import test from "node:test";

import { draftIntegrityFreshness } from "../../apps/desktop/renderer/draft-integrity.ts";

test("draft integrity accepts only the head requested by the active renderer", () => {
  assert.equal(
    draftIntegrityFreshness("head-a", "head-a", "head-a"),
    "current",
  );
  assert.equal(
    draftIntegrityFreshness("head-a", "head-b", "head-a"),
    "active-head-changed",
  );
  assert.equal(
    draftIntegrityFreshness("head-a", "head-a", "head-b"),
    "checked-head-changed",
  );
});
