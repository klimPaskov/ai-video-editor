# ADR 0019: Full AI edit with motion graphics

- Status: Accepted user requirement (2026-10-07); implementation in progress
- Scope: a separate AI editing mode, a motion-graphics layer, and the editor tools that give an assistant enough freedom to produce a polished edit

## User requirement

Besides manual editing, a user can hand a whole video to Claude to edit from start to finish, or later ask Claude to improve an existing edit with better transitions, graphics and pacing. The result should look deliberate and professional while staying easy to follow. The app is the harness: it gives the assistant broad but safe editing tools through its MCP server and clear editing guidance. Claude is the default; the tools are shared with the other assistant routes where their protocols allow.

## Decision

1. **Motion graphics are HTML and CSS.** A graphic is an HTML fragment with its own CSS, anchored to a point in a source recording, lasting a fixed output duration. Language models write HTML, CSS, SVG and CSS animations fluently, which gives the assistant real creative freedom. Graphics contain no scripts and load nothing from the network.
2. **One renderer for preview and export.** Graphics render in an isolated stage page (`stage.html`) that seeks every CSS animation to an exact time. The preview shows that page over the player; export captures it offscreen frame by frame (Electron offscreen rendering) into a lossless intermediate and overlays it in the existing compositor. Frames without graphics stay bit-identical. A prototype captured 1920×1080 transparent frames deterministically at about 100 ms per frame with software rendering.
3. **Transitions are graphics that cover a cut** (wipes, dips, panels, title cards), so they need no separate engine. Crossfades that need extra footage beyond a clip's edge are a later step.
4. **The assistant can see.** A frame tool returns rendered pictures of the edit (with zooms, captions and graphics), so the assistant can check text, placement and timing.
5. **Full AI edit is its own mode.** The user gives a short brief (goal, audience, style, how far to go). The assistant runs one long session with a written editing playbook. All its changes form one pass that can be undone together. A later "polish" run starts from the current edit.
6. **External agents** may later connect to the running app's MCP server with a per-user token, using the same guarded tools.

## Consequences

- New draft data (`graphics`) with schema, validation, transactions, Undo and journal replay.
- A stage page served by the app with its own Content Security Policy (inline styles allowed, scripts and network not), loaded in an iframe in the preview and an offscreen window in export.
- More assistant tools and a longer, structured system prompt for the full-edit mode; the Claude init inventory check grows with them.
- Export time grows with the length of on-screen graphics.

Details: `docs/50_FULL_AI_EDIT.md`.
