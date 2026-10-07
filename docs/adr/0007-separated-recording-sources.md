# ADR 0007: Separate recording sources

- Status: Accepted starting decision
- Date: 2026-09-04

## Decision

Record screen, camera, microphone, system audio, and pointer telemetry as separate synchronized sources whenever the platform supports them.

## Consequences

- Layouts, audio cleanup, and camera timing remain editable.
- One monotonic clock and explicit offsets are required.
- The app builds an automatic initial timeline after recording.
- Combined fallback recording is allowed only when the platform cannot provide separate capture, and the limitation must be visible.
