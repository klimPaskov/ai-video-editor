# Getting started

## Requirements

- Linux with an X11 session (Windows packaging is in progress; macOS is not supported yet)
- [Node.js](https://nodejs.org/) 24 and Python 3.9 or later
- [FFmpeg](https://ffmpeg.org/) and `ffprobe` on your `PATH`, used for recording, preview copies and export
- For the Claude assistant: [Claude Code](https://docs.claude.com/en/docs/claude-code/overview) 2.1.268 or later

## Build and run

```bash
git clone https://github.com/klimPaskov/ai-video-editor.git
cd ai-video-editor
npm ci --ignore-scripts
npm run desktop:build:local
```

The build prints the path of the packaged app, for example
`test-results/desktop-build-XXXX/packaged/ai-video-editor-linux-x64/ai-video-editor`. Run that file to start the editor.

## First steps

1. On **Home**, choose **New recording** or **Import video**. Imported files are copied into the app's library; the originals are never changed.
2. The project opens in **Record or Import**. Move through the steps at the top: **Auto Edit**, **Edit**, **Review** and **Export**.
3. In **Auto Edit**, choose **Transcribe locally** to create a local transcript. The first time, the app asks before downloading the speech model (about 76 MiB).
4. Run **Magic Edit** for a first cut, then refine it in **Edit**.
5. In **Export**, save a lossless master or a smaller MP4.

## Connect an AI assistant (optional)

Open **Settings** (Ctrl+,) and choose a connection:

- **Claude** (default): install Claude Code, then choose **Sign in**. Sign-in opens Anthropic's page in your browser. Your Claude plan is used; the app never handles your credentials.
- **Codex**: sign in with your ChatGPT account.
- **API providers**: paste an OpenAI, Gemini or DeepSeek API key. Requests are billed to that key.

See [AI assistant](ai-assistant.md) for what the assistant can do.

## Where your files are

The app keeps its library, projects and recordings in its data folder (`~/.config/ai-video-editor` on Linux). Exports are saved wherever you choose.
