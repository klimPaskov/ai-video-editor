# Native computer-use testing

## Environment boundary

The implementation agent must build and run the product app only in its isolated desktop environment. The latest user instruction prohibits controlling the host PC: all native input and screenshots must remain inside Docker. Do not use host computer-use tools or operate/capture a host viewer. Historical viewer authorization is superseded; any future viewer use requires a new explicit request. Do not access host capture devices, unrelated personal files, credentials, or display sockets outside the narrow explicitly authorized test setup in ADR 0006.

The current [Docker environment](../tests/desktop/README.md) provides a private Linux display, an unprivileged user, dropped capabilities, restricted seccomp, and no host mounts or devices. Use `tests/desktop/guest-input.py` inside that guest for native input and screenshots. It uses X11/XTEST via ctypes and FFmpeg x11grab, guarded by Linux, `/.dockerenv`, UID 1000 and display `:99`. The existing authenticated loopback VNC endpoint is not the current testing route. Retain Chromium sandboxing; do not use `--no-sandbox` to make a test pass.

Docker 28.5.2, Electron 44.2, and Playwright 1.63.0 passed the environment probe. Earlier TigerVNC observations are historical; the later host-viewer 200% attempt was stopped by the user and did not pass. The current guest-only path captured the desktop, closed the probe, opened the actual product source, opened Settings with Ctrl+,, selected and saved 200%, opened Source details, and advanced the actual frame to 0:00.500 without host input. Native 200% tests passed separately. These bounded observations do not prove full P1 acceptance, Windows devices/installers, audio listening, or high-precision display fidelity.

## Browser role

Use the integrated browser for public research and documentation. Do not use a browser-hosted clone as product evidence.

## Native test layers

### Unit tests

Domain operations, time conversion, history, schemas, policy, IPC validation, and Codex message parsing.

### Integration tests

FFmpeg fixtures, transcription adapters, project recovery, app-server fake transport, real app-server smoke when authenticated, and render QA.

### Playwright Electron

Launch the Electron app, obtain the first window, stub native dialogs where needed, interact through accessibility selectors, capture screenshots, and close cleanly.

For P5-01, run the packaged `tests/native/transcription.test.ts` fixture from [the desktop test guide](../tests/desktop/README.md). It verifies the visible local-transcription action, pinned model integrity, word timing, job reuse, source preservation and reopen in Electron. Use guest-only computer capture for the actual Auto Edit and expanded transcript view; model files and transcript content stay inside Docker.

The same native fixture now also opens Edit, corrects one word as text-only draft metadata, applies shared Undo/Redo, and reopens to check that the correction persists while the original ASR transcript and source bytes remain unchanged. Its correction and Auto Edit visual holds are distinct; inspect each actual guest screenshot separately.

### Computer use

Operate and capture the actual guest native window using the guarded guest helper. Inspect the latest guest screenshot before choosing a coordinate or key, perform one action, and inspect its resulting screenshot. Test resize, focus, selection, drag handles, menus, keyboard shortcuts, progress, errors, and final playback as implemented. Record exact steps and screenshots privately. Do not infer a visual pass from helper exit status alone.

### Capture tests

Use virtual camera, microphone, system-audio, and screen sources for deterministic runs. When the environment has no real device, say so. A virtual-device pass is not a claim that every physical device works.

## Test data safety

Use generated media and the two supplied example videos only. Never capture unrelated desktop content, notifications, credentials, or personal files.

The 2026-09-12 user-authorized credential seeding in ADR 0006 transferred only the official runtime credential file directly into the private app-owned guest account with mode 600. No host mounts, configuration or history were copied, and the host file was unchanged at transfer. Production onboarding remains managed sign-in; the exception adds no renderer credential input or general import feature. Keep secrets and account-identifying data out of captures and evidence. The packaged account probe reported connected/signed_in with runtime model, skill and usage discovery; it did not complete a browser login or prove a Codex edit.

The later authenticated synthetic packaged run passed a real guarded trim and Codex undo through the shared journal. It observed committed preview pixels and controls during the turn, preserved the source/baseline, reopened the same thread and history, and stopped a separate read-only turn without another transaction. Guest-only input switched the Codex drawer to the Source inspector in the actual native window. A later guest-only inspection repeated that drawer-to-inspector switch during a native-child attempt, but authoritative history contained no spawn or child read, so it is visual evidence only. An offline guarded-service stale request against a real Codex native edit passed without changing the draft, journal, source or baseline; no new window launch was needed for that continuation. Retain private results and failures separately. Complete effective tool-policy and native subagent inheritance checks remain pending; account discovery alone proves neither.

A subsequent bounded negative probe used the packaged guest window and a fresh synthetic fixture to ask for a harmless built-in directory listing. The live thread returned ready; the official persisted turn contained no command, file, dynamic or unrequested tool item, and journal/source/baseline were unchanged. Guest-only input again replaced the Codex drawer with Source details. The model's refusal is not proof that the model-visible tool catalog excludes every forbidden capability. Its first audit failed because a separate bare resume reapplied defaults; the corrected audit used product policy overrides. Keep both records private and the full P2 restriction gate open.

## P1 lifecycle and accessibility checks

Run `tests/native/lifecycle.test.ts` against a packaged guest executable. It tests normal shutdown, second-instance behavior, process-kill reopening, corrupted preferences, actual renderer-crash dialogs and missing assets in a task-owned package copy. Preserve the original build and fixture bytes. Native dialogs in this suite are real; screenshots still require visual inspection.

Run `tests/native/accessibility.test.ts` for keyboard project navigation, focus, measured primary-button contrast, emulated forced colors/contrast preferences and reduced-motion chrome with unchanged preview samples. Emulation inside Electron does not establish Windows OS integration.

Run `dbus-run-session -- node tests/native/orca-smoke.test.ts <absolute-packaged-executable>` only inside the isolated image with Orca and AT-SPI dependencies. The real screen reader, observer and Electron share a private session bus. Speech and physical braille are disabled; require actual Orca braille-monitor output and named/typed focus events belonging to the packaged application's process IDs. Inspect full guest screenshots of that output. Test natural activation first; any separate `--forced-accessibility` run is explicitly forced, not proof of automatic detection. This is a bounded Linux control-output smoke test, not speech listening, physical braille, error-announcement coverage or full accessibility certification.

Use the pinned comparison recipe in `tests/desktop/README.md` for Orca 50.2 and AT-SPI2 2.56.8. Keep old-reader failures distinct from new-reader passes. The harness records version, package and test hashes before startup and confirms reader settings through its supported API. Build each comparison from verified archives in fresh directories; do not reuse unverified extracted sources or generated build rules. Successful provisioning alone is never a passing smoke test.

## No visual shortcuts

A DOM assertion or screenshot diff does not replace watching motion and audio. A native computer-use pass does not replace deterministic tests. Both are required for final acceptance.
