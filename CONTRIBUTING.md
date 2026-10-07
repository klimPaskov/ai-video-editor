# Contributing

Thanks for your interest in improving AI Video Editor.

## Set up

You need Node.js 24, Python 3.9 or later, and FFmpeg with `ffprobe` on your `PATH`.

```bash
npm ci --ignore-scripts
python -m pip install -r requirements-validation.txt
npm run check
```

`npm run check` runs type checking, linting, formatting checks, the Python foundation tests, the media test suite (real FFmpeg encodes and decodes) and the schema and contract validators. It does not open a window or use capture devices.

## Desktop and native tests

`npm run desktop:build:local` builds the app on your computer. Native UI tests in `tests/native/` drive the packaged app with Playwright and are run inside an isolated desktop environment (see [tests/desktop](tests/desktop/README.md)), using synthetic media and labelled fake capture devices.

## Making a change

- Keep changes small and focused, and add or update tests with them.
- Every edit to a draft goes through the shared transaction engine so Undo keeps working; never modify source media.
- When behaviour changes, update the matching specification in `docs/`, the schemas in `docs/schemas/` and the user guide in `docs/guide/`.
- Run `npm run check` and `npm run check:publication` before opening a pull request. The publication audit rejects credentials, private paths and media binaries in staged files.
- Use the pull request template and say which checks you ran.

Never commit recordings, projects, transcripts, credentials or model weights. Test fixtures must be synthetic or cleared for redistribution.

## Where things are

- [Documentation index](docs/README.md): specifications, design decisions and contracts.
- [Task list](docs/development/TASKS.md): planned and in-progress work.
- `AGENTS.md` and `CLAUDE.md`: instructions for AI coding agents working on this repository.
