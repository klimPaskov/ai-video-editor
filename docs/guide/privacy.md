# Privacy and data

## On your computer

- Imported videos are copied into the app's library and never modified. Recordings, projects, transcripts and caption settings are stored in the app's data folder (`~/.config/ai-video-editor` on Linux).
- Transcription runs locally. The speech model (Whisper base, about 76 MiB) is downloaded from Hugging Face once, after you confirm, and stored in the same folder.
- Exports are written only where you choose.

## Sent to an AI service

Nothing is sent until you ask the assistant something. Then the app sends your request and the project details the assistant reads, such as the timeline, transcript excerpts and file names. Video and audio are not uploaded.

- **Claude** requests go through your installed Claude Code to Anthropic.
- **Codex** requests go to OpenAI through the bundled Codex runtime.
- **API providers** send requests to the provider whose key you entered. The app asks before each paid request.

## Credentials

Claude sign-in happens in Anthropic's browser page through Claude Code; the app never reads or stores Claude credentials. API keys are encrypted with your operating system's secure storage and are not shown again after saving.
