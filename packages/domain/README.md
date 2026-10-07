# Domain

Shared contracts used by every other package: project and timeline models, the draft transaction format, IPC view and request validators, and the pure editing logic that preview and export share.

Highlights:

- `draft-transaction.ts`: edit intents and the journal record format.
- `zoom.ts`, `speed.ts`: zoom and speed math, from output time to source time and FFmpeg filters.
- `captions.ts`: caption grouping, SRT/VTT and burn-in (ASS) generation.
- `magic-wand.ts`: the Magic Edit first-cut planner.
- `short-clips.ts`: short-clip discovery and reframing filters.
- `*-view.ts`: validated, path-free shapes exchanged with the renderer.
