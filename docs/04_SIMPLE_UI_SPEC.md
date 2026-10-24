# Simple UI specification

## Visual goal

The interface should feel like a focused creator tool. It should not look like an operations dashboard, development console, or traditional professional NLE.

## Rules

- One primary action per screen.
- One inspector panel open at a time.
- No permanent left navigation listing every feature.
- Use the five-stage stepper: Record or Import, Auto Edit, Edit, Review, Export inside projects.
- Keep the AI drawer collapsed until invoked or active.
- Use ordinary language such as “Preparing captions” instead of process names.
- Put technical logs under Help > Diagnostics.
- Hide advanced codec, model, and timing details by default.
- Prefer direct manipulation over forms.
- Keep warnings close to the affected item.
- Do not fill empty space with metrics or status cards.

## Current interface (ADR 0024, 2026-10-24)

The interface follows the Light Canvas reference designs (kept privately in `local-data/design-options/`): a plain application bar (logo, name, a quiet Claude button, source details, Home, Settings); a stepper row under it (five 40 px circles joined by long lines, labels below; done = outlined with a check, current = filled with a bold label); the picture, player bar and timeline together in one white rounded card; the step's one action below the card (Auto Edit: "Edit my video" pill and a "More options" disclosure; Import: file chip, duration, Add footage, then "Continue to Auto Edit"; Edit: a floating toolbar of icon-over-label tools with "More tools"; Review: Original, Edited and Clips figures with "Verify draft" and "Continue to Export"; Export: the card on the left, quality and Export… on the right with Short clips as a disclosure). Home is a headline, two large tiles (New recording, Import video) and the Recent projects. Themes (Light Canvas default, Studio Dark, Paper, Cinematic, Custom) are chosen in Settings; Cinematic lets the picture fill the window with frosted-glass controls.

Deviations from the references, because the real app needs them: the picture's player bar has no volume or fullscreen control yet; the Edit timeline is one clip bar rather than a thumbnail filmstrip with a time ruler and Zoom/Graphic flags; Export keeps a quality dropdown instead of two selectable cards; at 820 px and narrower the stepper becomes a list.

## Editor layout (earlier text, kept for the tool details)

### Top bar

Project name, compact current-step navigation, undo, redo, and the relevant next action. Show save failure or unsaved changes when relevant, never a persistent readiness badge.

### Preview

Large and central. Selected zoom, camera, or B-roll items show direct on-canvas handles.

### Tool rail

Compact buttons:

- Select
- Split
- Magic Wand
- Zoom
- Speed
- Captions
- B-roll
- Layout
- Audio

Selecting a tool opens its small inspector and closes the previous one.

### Timeline

Use fixed semantic tracks, not unlimited free-form tracks:

- main screen or imported video
- camera
- audio
- B-roll and overlays
- text and captions
- effects markers

Tracks can collapse. The default view shows only tracks with content.

### Codex drawer

A bottom-right drawer contains natural-language editing, a model selector, current selection context, concise activity, and recent applied actions. Reopening a project restores a bounded, redacted recent conversation from the real project thread; an authoritative in-progress turn reopens as running and remains stoppable. Raw reasoning, server identifiers, cursors, skill paths, and full command logs are not shown.

The P2 conversation slice implements a compact drawer beside the preview. Opening it closes the source inspector so only one panel is visible. A real selected project and signed-in runtime selection are required before a conversation can open. The renderer shows only projected user/Codex text, generic work/subagent/edit activity, Stop while a turn runs, and actionable failure or uncertainty. It never seeds sample conversation text or invents an edit result. Leaving a project first performs an idle thread unsubscribe and refuses while a turn is active.

ADRs 0014 and 0015 add optional OpenAI API, DeepSeek and Gemini API provider choice within the same compact AI surface. Selecting a provider must show only its verified model and capabilities, a clear separate API-billing label, and the context disclosed before first use. A paid turn starts on a deliberate user action. Do not claim Codex thread history or subagent activity for an API provider; never show key bytes. Packaged synthetic evidence is separate from authenticated provider acceptance.

## Interface settings and focus

The P1 settings/focus slice implements persistent interface scale choices of 100%, 125%, 150%, and 200%. Main owns preference storage behind strict typed get/set IPC; renderer state and a success toast update only after an actual successful save. Cancel or Escape dismisses unsaved choices, and load/save failures provide actionable messages without claiming success or discarding the prior saved scale. The modal traps keyboard focus and returns it to its invoking control when closed. Ctrl+, opens Settings.

Source information shows real imported-media metadata in one inspector. Opening Settings hides that inspector; closing Settings restores it when its source remains selected. Closing the inspector returns focus to Source details. Opening a source focuses its Back control, and Back restores focus to the selected source card. Interface scaling does not change source samples, preview quality, or master settings.

This slice does not implement the five-stage project shell or complete P1 accessibility acceptance. Packaged native testing remains required at supported window sizes and scales; contract and unit checks alone do not prove those interactions.

The extension to 200% addresses P1-05's full scaling range. Prior native evidence covers the earlier settings/focus slice, including 150% computer-use inspection. Packaged native keyboard/focus/layout tests and guest-only visual input/capture passed at 200%; this does not complete the remaining P1 requirements.

## Empty states

The implemented P1 project shell shows real Projects separately from the retained Source library. Import creates a project after successful ingestion; legacy sources offer Create project. Project views have compact five-stage navigation, with a five-choice select at narrower widths. Update selected stage only after main confirms persistence; failures retain the previous stage. Home returns focus to the originating project/source when applicable, and asynchronous replies must not override later navigation or focus choices.

The current preview, playhead and one inspector remain available across stage navigation. A project labels this surface Project preview and derives its duration, seek bounds and frame mapping from the committed draft; a Source library item remains a source-frame preview. Committed draft events replace only the current project timeline state, preserve the selected workflow step and open drawer/inspector, clamp an out-of-range playhead, and discard frames from older heads. Unimplemented stages do not add filler descriptions, fake Magic Wand output, editing controls, review findings, or export controls. Packaged native tests passed sizing, keyboard/focus and five-stage persistence. Guest-only visual review confirmed the compact five-choice selector, retained frame across navigation, and one scrollable source inspector; P1 is accepted in its result record.

Every empty state offers one clear next action. Do not show disabled tool grids before media exists.

## Text and chrome budget

Do not add a page title where the selected step or tool already tells the user where they are. Omit headings such as Edit Video, Visuals, and Review Your Video when they repeat navigation. Omit descriptions such as Add captions, B-roll, camera layout, and cursor emphasis.

Use short labels for real controls and screen-reader names for icon-only controls. Do not remove necessary warnings, confirmation details, capture indicators, filenames, or error recovery guidance. Long help belongs in an optional help surface.

No Ready indicator or debug footer appears in the bottom-left corner. No tool versions, local-service health list, QA dump, model logs, or filesystem paths occupy the normal editing view. A capture timer and microphone meter are recording controls, not debug clutter.

The Codex drawer is readily accessible and can stream edits without being permanently expanded. Opening it replaces the inspector at every window width. Closing it can restore the selected tool inspector. Never squeeze the preview behind a transcript, inspector, chat, and global sidebar all opened by default.
