# Accessibility

## Requirements

- All actions are reachable by keyboard.
- Use semantic controls and accessible names.
- Keep visible focus indicators.
- Do not communicate state by colour alone.
- Support 100 to 200 percent UI scaling.
- Keep readable contrast in light and dark themes if both ship.
- Provide text alternatives for icon-only controls through tooltips and labels.
- Make timeline operations available through keyboard and numeric inspector fields.
- Announce background progress and completed AI operations without flooding screen readers.
- Respect reduced-motion settings in app chrome while preserving video preview accuracy.

## P1 verification scope

The P1 contrast repair uses primary backgrounds with at least 4.5:1 text contrast in normal and hover states. The current stage has an underline as well as color. Forced colors retain system-colored borders/focus; higher-contrast preferences strengthen control boundaries. Reduced-motion rules affect app chrome only and must not alter decoded source pixels or preview timing. Verify these in the packaged guest before acceptance.

Screen-reader evidence requires the actual reader's output. The Orca test image supplies a private session bus and braille monitor with speech/physical braille disabled; an AT-SPI tree alone is insufficient. Natural detection and forced API activation are separate outcomes. Store screenshots/output privately and state the bounded Linux scope.

Record the exact reader and AT-SPI versions, package hashes, test-source hash and runtime settings with each run. Orca 43.1 retained missed-announcement failures in the isolated guest. The separate unmodified Orca 50.2/AT-SPI 2.56.8 comparison must meet the same control-output assertions; a newer dependency or successful installation alone is not acceptance. Use the reader's supported version-specific startup and settings APIs, confirm settings through readback, and wait for monitor painting before taking visual evidence. This Linux smoke scope does not establish Windows screen-reader support.

Production styling (2026-10-07) keeps the P1 guarantees: primary actions keep at least 4.5:1 contrast in normal and hover states, the current step and selected Settings section are underlined in forced-colors mode, focus rings are 2 px, all icons are aria-hidden, and reduced motion disables every animation (the slow-frame notice then appears without fading). `tests/native/accessibility.test.ts` and the scale checks in `tests/native/desktop.test.ts` pass on this styling.

## Captions

Caption defaults should remain readable, safe from canvas edges, and editable. The app should warn when a user style becomes too small or low contrast.

## Testing

Include keyboard-only, screen-reader smoke, zoomed UI, high-contrast, focus order, and reduced-motion tests. Computer-use review must verify visible focus and clipped text at common window sizes.

The P1-05 scale extension adds persisted 200% alongside 100%, 125%, and 150%. Check the actual packaged window at 200% for reachable controls, retained focus, readable labels, bounded preview/inspector layout, and scrolling that does not hide navigation. Scale is presentation-only and cannot alter source samples or master quality. Five storage and seven IPC tests passed for the extension, followed by isolated packaged native keyboard and sizing tests. Current local checks passed with 29 Python tests, 22 TypeScript tests and 27 schema/example pairs. Guest-only native input/capture verified Settings at 200%, Source details and Next frame without host control. The earlier host-viewer 200% attempt was user-stopped and is not evidence of success. This bounded pass does not complete P1 or screen-reader/high-contrast/reduced-motion acceptance.
