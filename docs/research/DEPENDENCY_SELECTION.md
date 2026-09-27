# Foundation dependency selection

Checked 2026-09-05 using the npm registry and the installed executables. Exact dependency resolution is in package-lock.json.

- Node: local v24.15.0; development and CI use the Node 24 line. Native TypeScript stripping is limited to erasable syntax and backed by a separate strict typecheck.
- TypeScript: registry latest was 7.0.2. Installation correctly refused it because typescript-eslint 8.69.0 declares TypeScript >=4.8.4 and <6.1.0. Selected registry-confirmed 6.0.3, without forcing peer dependencies.
- ESLint 10.10.0, typescript-eslint 8.69.0, Prettier 3.9.6, and @types/node 24.13.3 were resolved from current registry metadata. `npm install --ignore-scripts` completed with zero reported vulnerabilities.
- Electron 44.2.0 and Playwright 1.62.1 are research candidates for P1; neither is installed or launched by this P0 foundation. See P0_FOUNDATION.md for primary source verification.
- Local FFmpeg identifies `N-123778-g3b55818764-20260331`. The encoder evidence records its actual version, rather than assuming the current stable 9.0.1 was used. CI records its own installed version per fixture; exact redistribution selection remains open.
- Codex CLI 0.142.3 is available locally. Protocol generation and runtime authenticated acceptance are separate checks. Generating a schema does not establish a working signed-in session.

The foundation does not install application runtimes globally or bundle their binaries. Dependency changes must pass the complete check command and privacy review before publication.

## P5 local speech runtime, 2026-09-27

The first local ASR implementation uses `@huggingface/transformers@4.3.0` with its Node CPU backend and the revision-pinned Apache-2.0 `Xenova/whisper-base` q8 model. The app downloads and hash-checks the model only after the user starts Transcribe locally. The packaged worker and native runtime dependencies are verified in the isolated Docker build. Model weights are not bundled. See [P5_LOCAL_TRANSCRIPTION.md](P5_LOCAL_TRANSCRIPTION.md) for hashes, provenance, privacy boundaries, and fixture limits.
