# Vendored files

- `hyperframes-runtime.js`: `dist/hyperframe.runtime.iife.js` from `@hyperframes/core` 0.8.170 (https://github.com/heygen-com/hyperframes), Apache License 2.0 (`HYPERFRAMES-LICENSE`), unmodified. It plays HyperFrames compositions inside the app's sealed composition frames (ADR 0021).

Animation libraries that compositions reference (gsap, lottie-web, three, animejs) are not vendored: the app fetches the exact pinned files from jsDelivr on first use and caches them on the user's machine.
