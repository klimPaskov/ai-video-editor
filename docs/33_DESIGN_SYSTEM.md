# Simple native design system

## Direction

The app should feel focused, direct, and easy to learn. Use current creator-tool patterns as reference for restraint and workflow clarity. Do not copy another product's branding, wording, assets, or exact composition.

## Window structure

The normal project window has four areas:

1. Compact top bar with project name, compact current step, undo, redo, and the relevant next action.
2. Main canvas or task content.
3. Bottom timeline only during Review.
4. One context panel or a collapsed Codex drawer.

Do not show a permanent multi-section sidebar. The Home screen and Settings may use a compact navigation list. Project screens use a step header and Back action.

## Progressive disclosure

- Show one primary action.
- Show no more than one inspector.
- Hide empty tracks.
- Collapse advanced settings.
- Replace raw logs with plain status.
- Put diagnostics behind Help > Diagnostics.
- Keep the Codex drawer collapsed until the user opens it or Codex needs a decision.

## Core components

- primary and secondary buttons
- segmented choices
- source cards
- simple device picker
- preview canvas
- compact timeline ruler and tracks
- selection inspector
- Magic Wand menu
- progress sheet
- toast and blocking alert
- review finding row
- model picker
- searchable local asset picker

## Visual tokens

The included current individual screenshots establish the dark palette and accent direction. Apply their mandatory correction notes. Start with:

- neutral dark and light themes
- one accent colour
- high contrast text
- 8 px spacing grid
- 8 to 12 px radii
- 40 px minimum primary control height
- 44 px minimum pointer target where space allows
- restrained shadows and borders
- motion between 120 and 240 ms for ordinary UI transitions

Implemented tokens (2026-10-07, `apps/desktop/renderer/style.css`): background #0b0d13 with three surface steps, borders #252a39/#363d54, text #eceef4/#a4aabb/#767d92, one violet accent #6d4aff (white text 5.15:1; hover darkens to #5c3bef), red only for recording and destructive marks, green only for positive results. 8 px radii for controls, 10 to 14 px for panels, 36 px compact controls in toolbars and 40 px or more for primary actions. Icons are inline 24 px stroke SVGs injected from `data-icon` and hidden from assistive technology; every control keeps its text or aria-label. A system font stack (Inter or Segoe UI when installed) is used; no font is bundled.

Decision (2026-10-07): item 3 of the window structure is revised. A compact read-only timeline strip is shown in every project step, not only Review, because trim, split, range marks, Magic Edit and assistant edits all change the draft and users need to see the result where they act. It stays one track high and carries no tools of its own.

## Typography

Use a bundled licensed UI font or a system stack. Normal body text should remain readable at 100 percent scaling. Avoid long explanatory paragraphs in the product UI.

## Empty, loading, and error states

Every screen needs an intentional empty state, cancellable loading state, recoverable warning state, and plain blocked state. Keep the user's completed work visible when possible.

## Native behavior

Support native menus, file dialogs, keyboard shortcuts, drag and drop, window resizing, display scaling, and standard focus behavior. Never open the main product inside a browser tab.

## No redundant chrome

Do not add hero headings, instructional subtitles, permanent Ready or Saved indicators, debug footers, repeated selected-tool names, or marketing language. Use one concise progress label when work is running. Default to a restrained dark theme with a single violet accent. Provider choice belongs in the compact AI settings/drawer only when more than one implemented provider is available, not on every editor screen. Model choice is scoped to the selected provider and its validated catalog.
