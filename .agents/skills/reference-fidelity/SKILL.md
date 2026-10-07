---
name: reference-fidelity
description: Implement simple native screens from individual references and correction notes.
---

# reference-fidelity

Read docs/references/IMPLEMENTATION_NOTES.md, the full-size mapped current image, and the screen spec. Use previous images only for alternatives. Remove repeated titles, obvious descriptions, readiness/debug footers, and permanent multi-panel layouts. Keep usable labels and genuine errors. Wire every control to state. Launch the native window in the isolated environment and inspect layout, interaction, scale, and accessibility. Never use an image as a fake working interface.

Update this reusable workflow when implementation reveals a repeatable failure or verified improvement. Keep project-specific footage and task transcripts out of the skill.

For a selected assistant drawer, inspect the native message-history height and error containment as well as the preview. A screenshot can reveal a clipped alert even when a DOM assertion passes; repeat at 1366×768 after correcting layout and retain the first failed run as failed evidence.

For a precision restore form in Edit, keep source and interval inputs beside the committed preview without opening another inspector. Inspect the filled form at the default window size and enlarged scale; verify labels and actionable overlap errors remain visible.
