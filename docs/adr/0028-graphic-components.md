# ADR 0028: A library of designed graphic components

- Status: Accepted 2026-10-25
- Scope: `graphics.component`, full-edit graphics guidance

## Problem

Every graphic was authored from scratch inside one long run, with no positive examples and no way to check taste cheaply. The user judged the results unimpressive and useless (2026-10-25).

## Decision

- Six finished, animated components (lower third, chapter card, stat callout, highlight box, keyword, step badge) live in `packages/domain/src/graphic-components.ts`. Each takes only content, a moment, a side/place and an accent colour; layout, type scale, easing, entry and a 0.45 s exit are fixed by the design. They are sized in container units and sit inside the title-safe margin.
- Claude places them with the Claude-only `graphics.component` (inventory twenty-six), which creates an ordinary `graphic` effect through the shared transaction path, so preview, export, Undo and short clips need no new code.
- The full-edit playbook splits the work: informational graphics (introductions, numbers, section entries, pointers, steps) use components and must clarify what is said; hero moments (opening, reveals, diagrams) stay authored compositions. Components are limited to about three a minute and must vary kind, side and place.

## Not done

A brand step (logo, palette, fonts), anchoring callouts to detected on-screen text, contrast and overlap checks in `composition.check`, and more kinds.
