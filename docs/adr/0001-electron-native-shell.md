# ADR 0001: Electron native shell

- Status: Accepted starting decision
- Date: 2026-09-04

## Decision

Use Electron with a packaged local renderer for the first Windows release.

## Reason

The product needs display capture, optional camera and audio capture, a custom desktop editor, direct child-process control, installer support, and repeatable Playwright Electron testing. Electron offers the shortest evidence-backed path while still producing a standalone desktop application.

## Constraints

- Do not serve the product from localhost.
- Load packaged local content only.
- Keep renderer sandboxing and context isolation enabled.
- Expose privileged functions only through typed, validated IPC.
- Revisit this ADR if recording quality or packaged performance fails acceptance tests.
