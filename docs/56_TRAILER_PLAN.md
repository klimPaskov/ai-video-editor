# Urushi launch trailer: plan

Status: plan (2026-11-02). Production starts when the redesign (docs/55) is merged and verified, because the trailer shows the real app. Nothing is published; the owner approves the music and the cut.

## Goal

A 75 to 90 second launch trailer that looks like a large studio made it: precise typography, motion graphics, beat-synced cuts and transitions, a considered colour grade and a strong sound design. Quality is the only acceptance bar. A mediocre result is rejected and redone.

## Rules from the owner

- Use the app's own workflow to make it (the app plus the owner's Claude sign-in, not an API key).
- Footage is the owner's existing recordings, general content only: no Hearts of Iron IV or other game content, no private or identifying material. Footage is screened frame by frame before use.
- No new real footage is shot now. Later, a video the owner makes with the finished app can be added to a second cut.
- **Dogfooding:** the trailer's screen footage is recorded by using the app. Every problem met while doing so is logged and fixed in the app, so the product improves while the trailer is made. Fixes are committed with the trailer work that found them.
- Nothing is published. The owner approves the song first.

## Story (about 85 seconds)

| Time | Beat | What the viewer sees |
| --- | --- | --- |
| 0:00 to 0:06 | **Open** | Black. A single gold brush stroke draws itself across the frame to a low swell; it settles into the mark and the name URUSHI. |
| 0:06 to 0:16 | **The problem** | A raw screen recording on a timeline: pauses, "um"s, a wandering cursor. Fast, slightly chaotic, desaturated. A cut on the first beat drop. |
| 0:16 to 0:32 | **Magic Edit** | One click on "Edit my video". The timeline tightens on the beat, zooms push into what matters, silence disappears. Numbers count up ("14 pauses cut"). |
| 0:32 to 0:46 | **Finish** | Captions, lower thirds, graphics and transitions arrive, each synced to the music. The assistant chat: "make the music quieter", and it happens. |
| 0:46 to 0:58 | **Camera and screen** | The speaker's camera and the screen morph between full camera, a corner and screen-only. |
| 0:58 to 1:08 | **Refine** | The simple screen: What Magic Edit did, six tools, Open full editor. The five themes switch in a quick montage. |
| 1:08 to 1:16 | **Export** | Export, then the Done screen: "Your video is ready." |
| 1:16 to 1:25 | **Close** | The mark, the name, one line of text, quiet. |

The tagline is open; candidates: "Say what you want. Watch it cut." and "Edited for you. Finished by you."

## Music

- The song must be legally usable and approved by the owner. I shortlist three to five tracks from libraries with commercial-use licences (Pixabay's licence, tracks on Free Music Archive under CC0 or CC BY, others only with the terms checked on the track page), with title, length, tempo, licence and a link, and the owner picks one. Nothing is downloaded or used before approval.
- Search so far found no ready-made match; the shortlist needs listening to real tracks, so it is made next. I will not claim a licence I have not read on the track page itself.
- Beat map: the chosen track is analysed (onsets and tempo) and every cut, transition and graphic is placed on that grid.

## How it is made

1. **Capture the app.** In the Docker guest the app is driven by scripted, human-paced interactions (Playwright) at 2560x1440 while the guest screen is recorded losslessly. Themes are switched, Magic Edit is run on the owner's footage with a real Claude, the assistant chat is used, Export and Done are shown. This is the dogfooding step.
2. **Design the motion.** Title cards, kinetic typography, lower thirds and the logo animation are authored as sealed HyperFrames compositions (the app's own graphics format), so they render through the app.
3. **Assemble in the app.** The clips and compositions are imported into Urushi; Magic Edit tightens, `graphics.component`, transitions and sound tools add the rest; the cut is placed on the beat map; the lossless master is exported, then a smaller MP4.
4. **Review.** Frames are decoded and looked at (every join, every graphic), and audio is checked. Weak moments are redone, not excused.
5. **Deliver** to the owner for approval in `C:\Users\klimp\Videos`, not inside the repository.

## Footage screening

Before any recording is used, sample frames are read to confirm there is no game content, personal data, names, credentials or other private material. Anything doubtful is out. Because the owner's own recordings are mostly screen content, the app's own clean UI recordings carry the trailer, with the owner's footage shown as the "before" material.

## Findings log

Problems found while using the app for the trailer are listed here and fixed in the app.

| Found | Where | Status |
| --- | --- | --- |
| A video with irregular frame timing imported but could not become a project (vague error) | Import | Fixed: a difference under one frame is accepted (`92bab32`) |
| Silent or oddly timed audio made Magic Edit fail | Magic Edit | Fixed (`e9a4b51`) |

## Open for the owner

1. Approve the song once the shortlist is ready.
2. Length: 85 seconds, or a 30-second cut as well for social media?
3. Tagline preference.
4. Anything else that must be in it (features to show, or to leave out).
