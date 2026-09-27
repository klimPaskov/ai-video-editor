---
name: simple-desktop-ui
description: Design and implement the quiet step-based creator interface.
---

# Simple desktop UI

## Use when

Changing screen flow, visual hierarchy, design system, editor panels, or empty and error states.

## Core rules

- Home plus five project steps: Record or Import, Auto Edit, Edit, Review, Export. QA is a screen within Review.
- One primary action per screen.
- One tool inspector open at a time.
- No permanent full feature navigation.
- AI drawer collapsed unless active or requested.
- Technical details behind Diagnostics.
- Large preview and direct manipulation in Edit; watch-through, comparison and quality findings in Review.
- Hide empty tracks and unavailable controls.
- Use plain user language.

If only a structural draft-integrity check is implemented in Review, show one Check draft integrity action there and report only what main actually revalidated. If the current manual group has a structural checkpoint, say so explicitly; otherwise state that no manual checkpoint was recorded. Clear the result when the committed draft head changes. Do not label the result a full review, semantic speech check, playback, A/V join review, or export readiness.

Hide the Review integrity action while the Source inspector or Codex drawer is open, and clear its transient result on panel changes. Keep the check in the Review stage beside the preview; do not turn it into a persistent status dashboard.

For a partial Edit tool, put only actionable trim, Split and Undo controls by the current preview position. Show which part or fragment a two-source action targets, disable trim and Split at fragment boundaries or during a save, and retain the single-inspector/drawer rule. Do not add inactive tracks or a fake full tool rail to match a reference image.

For marked range cutting, keep Mark in, Mark out, Cut range and Clear adjacent to those Edit controls. Show only the marked times needed to understand the pending cut, disable Cut range for missing, reversed, empty or whole-draft marks and while saving, and clear stale marks when the committed head or project changes. Show the shortened preview from committed state and preserve newest Undo. A cut across parts does not remove either part from the Source inspector or justify an additional panel.

For manual restoration, keep source choice and exact missing source-time bounds in a compact inline Edit form. Use full-precision microsecond timing from decimal seconds, disable invalid, overlapping or out-of-source intervals, and show a useful validation error. Resolve source identity against the immutable baseline in main; show the restored interval from committed preview state and preserve shared Undo/Redo. Do not infer missing speech or add an empty source-track panel.

For Auto Edit speech-candidate review, nest the transcript-derived list under the completed transcript disclosure. Show concise original-transcript context, source time, protection/disposition, and a still-frame seek control only when the current committed clip map contains the source point. Keep preview read-only; do not imply audio playback, present a candidate as an applied cut, or add a second inspector.

The compact AI drawer and Settings provider selector may offer Codex, OpenAI API, DeepSeek and Gemini API. Show one selected provider, its verified model choices, billing/context notice and recovery state; never combine several provider panels or imply a disconnected provider can generate. Gemini's function-call thought signatures and API keys are technical state, never UI content. A synthetic fixture label is test evidence, not a production assistant claim.

## Procedure

1. Start from the user task and current screen ID.
2. Define the one decision the screen supports.
3. Remove controls unrelated to that decision.
4. Preserve keyboard access and readable scaling.
5. Implement loading, empty, warning, blocked, and recovery states.
6. Test at common desktop window sizes.
7. Inspect with computer use and capture screenshots.

For a long assistant conversation, bound the selected drawer and let the history scroll inside it while the composer and actionable error remain readable. At compact native sizes, assert the alert is inside the drawer and visible in the viewport; finding its text in the DOM is insufficient.

Show an explicit Retry request action only for a server-confirmed failed Codex turn with a retained user request. Keep the failure warning about reviewing committed draft edits visible, and do not offer replay for interrupted or uncertain turns.

At 200% interface scale, retain a minimum usable history height and let the drawer scroll to a changed error. Review preview and drawer states separately in a small window; do not claim they fit simultaneously when the viewport cannot show both.

## Reference rule

Use future screenshots for principles and proportions. Do not copy brands, assets, or exact layouts.
