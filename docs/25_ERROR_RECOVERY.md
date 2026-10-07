# Error and recovery specification

## User-facing error pattern

Show:

- what failed in plain language
- what work is safe
- the best next action
- Retry when safe
- Details as a secondary action

Do not show raw stack traces in the main flow.

## Required recovery cases

- app crash during autosave
- interrupted Codex turn
- Codex process restart
- login expiry
- rate limit reached
- FFmpeg failure
- render cancellation
- missing or moved source
- disk exhaustion
- camera or microphone removal
- permission denial
- interrupted recording
- corrupt cache
- stale revision or tool transaction

## Recovery rules

- Source files remain untouched.
- Completed transactions stay valid unless dependencies changed.
- Incomplete transactions do not appear as applied edits.
- Draft journal replays only through the last valid checksum.
- Derived artifacts may be rebuilt.
- A valid prior export is never overwritten by a failed export.

## Implemented: interrupted recordings (2026-10-07)

A take cut short by a crash or forced quit is offered on Home with Recover and Discard; recovery keeps everything captured up to the interruption and never discards segments when it fails. Captures stop together with the app. See docs/06 "Crash safety and recovery".
