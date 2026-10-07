# ADR 0006: Isolated native testing

- Status: Accepted starting decision
- Date: 2026-09-04

## Decision

The implementation agent launches and tests the desktop application only inside its own isolated computer-use environment.

## Consequences

- Browser use is limited to research and public documentation.
- Playwright Electron provides repeatable UI automation.
- Computer use inspects the visible native window and rendered video.
- Virtual devices provide deterministic capture tests.
- Product builds, launches, and capture tests run only in the isolated guest environment.

## Historical scope resolution, 2026-09-05

The request to make the isolated environment available authorized host-side environment provisioning and a native viewer at that time. The earlier TigerVNC evidence retains that historical scope. It did not authorize a product launch on the host or mounting host personal files, credentials, devices, or display sockets into the guest.

## Current boundary, 2026-09-06

The latest user instruction prohibits control of the host PC. Under `AUTHORITATIVE_ORDER.md`, it supersedes the historical viewer exception: all native input and screenshots now remain inside Docker. Use guest X11/XTEST input and guest display capture alongside Playwright Electron. Do not operate a host viewer or capture its window; a future host-viewer session requires a new explicit user request.

The guest helper requires Linux, `/.dockerenv`, UID 1000 and display `:99`; it emits screenshots of that private guest display. This is actual native input/display evidence, not a browser substitute. Its scope remains Linux; it does not establish Windows product, capture, installer, audio-listening or high-precision display fidelity. See `docs/20_NATIVE_COMPUTER_USE_TESTING.md` and `tests/desktop/README.md` for reproducible checks.

## Explicit credential setup exception, 2026-09-12

The user explicitly authorized copying the official runtime's credential file into the private guest account for this session's authenticated testing. Under `AUTHORITATIVE_ORDER.md`, this narrow instruction overrides the earlier blanket prohibition on copying host credentials. Only that file was transferred directly into the app-owned guest account with mode 600; the host file was unchanged at transfer. No host account directory, configuration, history, mount, credential output or host UI access is authorized by this exception.

Production onboarding remains managed ChatGPT sign-in through the official runtime. This is private test setup, not a credential-import feature or general permission to copy credentials. Keep credential bytes, account identifiers and private locations out of source, logs, screenshots and public evidence. A packaged probe reported connected/signed_in and runtime models, skills and usage; this proves authenticated account discovery, not browser-login completion, a model edit or P2 acceptance. Continue with private synthetic-fixture native tests and record their actual results separately.
