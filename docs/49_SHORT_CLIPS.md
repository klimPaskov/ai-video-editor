# Short clips

User requirement (2026-10-07): once a video is done, the app also makes short-format clips from it, taking inspiration from BridgeClip (github.com/bridge-mind/bridgeclip, MIT). This document records what was adopted, what was adapted and what remains.

## What BridgeClip does, in brief

BridgeClip turns long videos into captioned short clips. It transcribes the whole source, asks a planning model for moments with explicit setup and payoff, then has a separate judge check each candidate for a clear opening, a complete ending, self-contained clarity and sponsorship, with fixed thresholds and no minimum clip count. It reframes to 9:16 by following faces and fitting screen content into panels, burns in captions in several styles, offers 1× to 2× speed with pitch kept, and keeps every export in a library. Its documents were read as research only; no code was copied.

## What this app does now

Short clips live in the Export step, after the main export, because they are made from the finished edit rather than from the raw source.

- **Find clips** reads the transcript of the current draft (output time, with text corrections, partly cut words dropped) and proposes up to six non-overlapping moments of 15 to 60 seconds (`packages/domain/src/short-clips.ts`). Each starts at a sentence and ends at the end of a sentence (or a pause of 1.2 s). Scores favour a new thought at the start (clips start only where a sentence starts; openings such as "And", "But", "That", "It" that usually depend on earlier context are penalised, and "So" or "Anyway" only slightly), an opening question, a complete final sentence, 25 to 45 seconds, and steady speech with few long silences or fillers. Only candidates scoring at least 0.55 are offered and there is no minimum count, so a draft without a good moment gets none. Cards show the title (the first sentence), time range, the reasons that applied and an excerpt. These are labelled as found from the transcript; they are local rules, not an AI judgment.
- **Preview** plays the clip in the main player and stops at its end. **Discard** hides a candidate. Candidates are stored per project with the draft head they were found on; after an edit they are marked as out of date until found again.
- **Export clip** asks for a file name and renders an MP4 through the same verified pipeline as the main export: the clip's output range is mapped through the clip map to source ranges, frames are reframed in one composition stage and encoded, and the file is checked for every frame before it appears. Formats: vertical 9:16 (1080×1920), square 1:1 (1080×1080) and landscape 16:9 (1920×1080). Framing: **Fit with blurred background** keeps the whole picture over a blurred, darkened fill of itself, which suits screen recordings; **Fill the frame** crops to the format at a chosen position. Captions are burned in by default using the project's caption style with shorter lines (26 characters for vertical and square) and, for vertical, placed 20% up from the bottom, clear of the controls social apps draw there.

## Differences from BridgeClip, and why

- No AI planner or judge yet. The app's AI connections (Claude by default, Codex, API providers) act only through guarded editor tools; a clip-proposal tool that lets them suggest or rank candidates with cited transcript lines is the next step, so that suggestions stay checkable and the local rules remain the fallback.
- No face tracking. This app's main input is screen recordings, where fitting the whole screen is safer than cropping to a face. Face and webcam-aware framing come later with camera layouts (P8-02).
- No speed change, title cards, chapters or posting yet.
- Exports are files the user saves; there is no separate clip library yet.

## Evidence

`tests/media/short-clips.test.ts` (sentence splitting, dependent openings avoided, ranges and scores, no clips from a short draft, window mapping through cuts, reframing filters), `tests/media/export-render.test.ts` (a vertical short with blurred fill and burned captions at 1080×1920), `tests/foundation/test_desktop_ipc.py` (path-free `shorts:*` contract) and packaged `tests/native/short-clips.test.ts` (a public 60 s talk excerpt transcribed locally, clips found, preview, a vertical MP4 exported with captions and checked for size, duration and fill, a discard).
