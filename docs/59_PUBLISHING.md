# Publishing text and upload

Requirement (2026-11-06): every finished video and every short clip gets the text needed to publish it, an organised place on disk, and a quick way to YouTube.

## What is written

For a finished video: a YouTube **title** (at most 100 characters, with other ideas to pick from), a **description** (an intro plus **chapters**), **tags** (at most 15, 450 characters in all), and posts for **X** (280), **Reddit** (title and body), **LinkedIn** and **Discord**. For a short clip: the same without chapters, with the clip's own title, tags and posts.

- **Chapter timestamps never come from a model.** They are the starts of sentences in the transcript, grouped into sections: at least three, the first at 0:00, at least ten seconds apart (YouTube's rules). A model only words the titles; a wrong count is ignored and plain titles are used.
- **No connected provider:** the plain version is drafted from the transcript (title from the project or clip name, keywords as tags) and the dialog says so. **Connected API provider:** the first provider with a key words the text in the chosen tone (Casual, Professional or Funny). Claude is not used for this yet because a text-only Claude turn needs its own guarded run kind; this is stated openly rather than faked.
- Edits are kept as they are typed (saved after a short pause and before copying, showing the folder or uploading) and checked against the same limits before they are stored.

## Where it lives

`Videos\Urushi\<project>\{Video, Shorts, Publish, Thumbnails}`: exports go to `Video` and `Shorts`; `Publish` holds `youtube.md` and `youtube.json` for the video and `Shorts\<clip title>.md/.json` for each clip. The folder names are made safe for Windows, macOS and Linux. The dialogs for saving a file still let the person choose any place.

## Screens

**Publish** is a dialog (not a workflow step) reached from **Publish text** on the Done screen and from **Publish text** on each short clip in Clips. Tabs: **YouTube** (YouTube header, title with a live length count, title ideas, description, editable chapter titles, tags as removable chips, and a thumbnail card from the footage with the title and length over it) and **Posts** (X with a ring counter and a solid Copy button, Reddit with a title and a vote-arrow body, LinkedIn and Discord composers, each with its own mark and colours and its own Copy). Designed from generated previews: `docs/design/ui-previews/publish-brand-*.png`. Below: **Wording** with **Write again**, **Copy title and description**, **Show in folder** and **Upload to YouTube**.

## Upload

**Upload to YouTube** is the always-working path: the title and description go on the clipboard, YouTube's upload page opens in the person's browser and the folder with the video is shown. No account is handled by the app. A direct API upload (OAuth with the person's own Google client, resumable upload, thumbnail) is a later option; Google keeps uploads from unaudited API projects private, so the Studio path stays.

## Thumbnails

Not built in the app yet. The plan: a frame from the footage chosen with the editor's own frame reading, 1280x720 under 2 MB, saved in `Thumbnails`. Generated images are out of scope for now by the person's decision.

## Security and privacy

- Every `publish:*` channel checks the sender, requires the request's project to be the open one, and validates its shape in preload and again in main (`assertPublishRequest`, `assertPublishSaveRequest`, `assertPublishThumbnailRequest`). Ids are `[A-Za-z0-9_-]` only, so a stored draft can never leave `userData/publish/<project>/`.
- The renderer never supplies a path: folders come from the user's Videos folder and the project name made safe for every file system (`safeFolderName`); a thumbnail is accepted only as a JPEG (magic bytes checked) of at most 2 MB, written through a staged file and rename.
- **Upload to YouTube** opens one fixed address (`https://www.youtube.com/upload`) and puts text on the clipboard; no account, token or cookie is handled.
- Writing with a connected API provider sends the video's name and the start of its transcript (at most about 2,400 characters) plus the section texts to that provider, which the person chose and keyed in Settings. Without a provider nothing leaves the device. This is the only network use added.
- Edits are checked against the limits before they are stored, and the plain draft is never presented as written by a model (`writtenBy`).

## Tests

`tests/media/publish.test.ts` (limits, chapters, parsing, drafts), `tests/media/publisher.test.ts` (folders, drafting with and without a model, edits, Open YouTube), `tests/foundation/test_desktop_ipc.py` (the five `publish:*` channels), and the native `short-clips.test.ts` and `export.test.ts` (dialog from a short and from the Done screen, files written, folder revealed).
