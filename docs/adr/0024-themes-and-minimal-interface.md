# ADR 0024: A minimal interface with selectable themes

- Status: Accepted; implemented 2026-10-24
- Date: 2026-10-24
- Scope: The renderer's look and layout, Settings > Appearance, the theme preference

## Context

The product's point is that the AI handles the edit. The first interface showed every tool at once (Magic Edit, Audio, Sound, Captions and Transcript on one screen; thirteen buttons in Refine), used one dark theme and made the current step easy to miss. The user asked for an extremely minimal interface with few things visible, a clear current step, a modern look, and a choice of looks, one of which changes the layout rather than only the colours.

## Decision

- **Few things at a time.** Each step shows its main action and little else. Magic Edit shows one action, "Edit my video" (rough cut, then the full edit, ADR 0020/0019), with one line of progress, Stop and a Review shortcut; Magic Edit alone, Audio, Sound, Captions and Transcript sit under "More options". Edit keeps Trim start, Trim end, Split, Undo and Redo; marking, cutting, zoom, speed and restore are under "More tools". Short clips are a disclosure in Export. Import and Review end with one "Continue" button.
- **A clear step indicator.** A numbered stepper: the current step has a filled number and a highlighted label, finished steps show a tick, later steps are dimmed. Each button keeps its step name as its accessible name.
- **Light Canvas is the default**, from the user's choice among generated design options (white cards on warm off-white, one blue accent, large radii, pill primary buttons).
- **Themes** (Settings > Appearance): Light Canvas, Studio Dark, Cinematic, Paper and Custom. A theme is a palette plus a layout. Cinematic changes the layout: the video fills the window and the step indicator, playback and the step's controls float over it as frosted glass. Custom has four colours (background, cards, text, accent) and a layout (Classic or Cinematic); the rest of its palette is derived in CSS with `color-mix`.
- **Readability is enforced.** Built-in palettes are checked against WCAG contrast limits by a test that reads the shipped style sheet. A custom theme is refused with a plain reason when its text is too close to the background or card colour (4.5:1) or its accent too close to the background (3:1); the button text on the accent is chosen as white or near-black.
- **Storage.** The choice is the optional `theme` in the main-owned preferences file (`{id}` or `{id: "custom", custom: {...}}`), validated in main and in the preload; only colours and layout names are stored. The renderer also keeps the last theme in `localStorage` so the next start paints it at once; the preference is authoritative. Choosing a tile applies it for judging; Cancel or closing restores the saved theme; Save keeps it.
- **No new capability.** Themes are CSS variables set through the CSSOM, which the page's Content Security Policy allows; no inline style or script is added.

## Consequences

- The previous dark look is now "Studio Dark"; users with no saved theme get Light Canvas.
- Native tests that use controls under a disclosure open them first (`tests/native/disclosures.ts`).
- Evidence: `tests/media/theme.test.ts` (validation, readable limits, preferences round trip, palette contrast), `tests/native/themes.test.ts` (every theme and the custom editor in the packaged app, Cancel, refusal of unreadable colours, restart persistence), `tests/native/one-click-edit.test.ts`.
- Not done: a themed Home with a recent-projects grid, animated transitions between themes, a high-contrast built-in theme beyond the OS forced-colors support.
