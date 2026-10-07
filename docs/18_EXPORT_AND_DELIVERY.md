# Export and delivery

The normal view contains filename, destination, and one quality choice: **Lossless master** by default, or **Smaller file** by explicit choice. Caption sidecars are optional. Keep codec and timing details under Advanced. Do not show a QA dashboard, redundant title, or success card before the export is done.

Lossless master uses the verified profile in `docs/44_LOSSLESS_MEDIA_POLICY.md`: Matroska with FFV1 and representation-matched PCM. Preserve source or canonical precision, timing, colour metadata, and channel layout. A compressed MP4 is an optional separate sharing output, never a silent default or a replacement master.

## Process

1. The user confirms export of the current revision and exact profile.
2. Freeze an export snapshot without discarding later editing ability.
3. Resolve immutable sources, current assets, and hashes.
4. Render canonical frames and audio from the shared timeline engine.
5. Encode and mux into a staging path with the correct extension.
6. Fully decode, inspect stream metadata, and verify lossless sample equality against the canonical render where required.
7. Verify timing, caption bounds, output hash, and current review state.
8. Write a delivery manifest including fidelity profile and explicit downgrade decisions.
9. Promote atomically to the chosen destination.

Codex may prepare settings, but must not invent user confirmation. A requested lower-quality preview must never lower master quality.

## Success and recovery

Show the final thumbnail, filename, Open video, and Open folder only after the exact output passes required checks. Keep detailed QA and hashes in optional details. Do not show export settings, running progress, and completion as simultaneous live states.

Cancellation preserves the project and earlier exports. Incomplete staging output is not advertised as a delivery. A later revision makes the previous review stale for that later revision only. Previous valid exports remain valid records of their own snapshots.

## Implementation (2026-10-07)

`packages/media-engine/src/render.ts` exports the committed draft; main owns the job in `apps/desktop/src/export.ts` and the Export step shows the quality choice, progress, cancellation and the verified result.

- **Canonical render.** Each clip keeps the source frames whose presentation time falls in its half-open source range. Its audio is exactly the source samples covering those kept frames, so cuts that are not frame-aligned never drift audio against video. Video for each clip is decoded with an input seek at least two seconds before the clip and an exact half-frame-margin trim; audio is decoded once per source from its start, because decoding after a seek did not reproduce identical AAC samples. Clips are concatenated in timeline order and may reuse or reorder sources.
- **Working format.** All sources used must share dimensions, pixel format, colour tags, frame rate, sample rate, channel layout and sample format. Mixed formats, variable frame rate, non-square pixels, rotation, interlacing and unsupported pixel or sample formats are refused with a fixed message instead of converted. Supported pixel formats are planar 8/10/12/16-bit YUV 4:2:0/4:2:2/4:4:4, BGRA/BGR0, GBR planar and grey; audio is preserved as packed PCM of the decoded sample type (16- or 32-bit integer, 32- or 64-bit float; 24-bit integer as `pcm_s24le`).
- **Lossless master.** Matroska, FFV1 level 3 with slice CRCs and every frame intra-coded, PCM audio, source colour tags, bit-exact muxing so identical renders give identical files. The rendered frames and samples are hashed while they are fed to the encoder; the encoded file is probed and fully decoded, and must reproduce both hashes and every frame and sample before it is published. Source hashes are rechecked after encoding.
- **Smaller file.** H.264 (CRF 18, yuv420p) and AAC 192 kb/s in MP4, chosen explicitly and labelled as compressed. It is fully decoded and its frame count checked; it is never described as lossless.
- **Publishing.** The destination comes from the system save dialog in main. Output is staged in a hidden directory beside the destination and moved into place only after verification; an existing file is replaced only when the dialog confirmed replacement. Cancellation and failure remove all staging. A delivery manifest with the evidence, draft sequence and output path is written under the app's private `exports` data, not shown to the renderer.

Evidence: `tests/media/export-render.test.ts` compares the master of a cut, reordered two-source H.264/AAC draft (including a clip that needs a seek) against an independent full decode without seeking, covers BGRA/16-bit PCM, the MP4 copy, refused mixed and variable-rate sources, replacement rules and cancellation. The packaged native test `tests/native/export.test.ts` imports a tagged H.264/AAC file, cuts a range, exports the master and the MP4 through the Export step, verifies the master against an independent decode, cancels a running export and checks the source is unchanged; it passed in the cloud VM on 2026-10-07 with screenshots reviewed.

Constant-rate sources whose container rounds timestamps (Matroska stores milliseconds, so 30 fps has 33/34 ms steps) are accepted when every frame lies within one tick (at least 1 ms) of `index / rate`; frame and sample positions then come from the exact nominal rate (`tests/media/export-render.test.ts`).

Captions: when captions are on, export writes an .srt beside the video after verification (docs/13); a failure there never removes the video, and an existing .srt is replaced only when the save dialog confirmed replacing the video. Not yet implemented: burned-in captions, mixed-format working-format conversion, truly variable frame rate, HDR transforms, export of zoom/speed/layout/caption effects, and a final thumbnail on the result.
