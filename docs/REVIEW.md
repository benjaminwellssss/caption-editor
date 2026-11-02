# Code and bug review — 2026-10-17

A full read of the repo at commit `0dc5e8b` ("Add autosort, trimming, GIF search, speaker fonts and
avatars, and hideable timelines"): `server.py`, `app.js`, `index.html`, `style.css`, both PowerShell
launchers, `docs/make_workflow.py` and the README. Fixes live on the `review` branch, one commit,
touching only `app.js` and `server.py`. Nothing else was changed.

## Overall

The code is in good shape for a ~2,500-line vanilla app. The state model is clear, every edit goes
through an undo/redo closure, the list and timeline share one selection, and the server is stdlib-only
with sensible path checks on everything it serves. The problems found are almost all at the edges:
what happens when a file is hand-edited, a request fails, or a browser API does not behave the way the
code assumes.

## Fixed on the `review` branch

| # | Where | Bug | Fix |
|---|---|---|---|
| 1 | `app.js` font browser | `document.fonts.check()` returns true for any family that has no `@font-face`, so the fallback that loads a `font_dirs` font from `/fontfile` never ran. Those fonts previewed in the fallback typeface. | `fontInstalled()` measures a probe string with the family over `monospace` and over `serif`; if both widths equal the bare fallbacks the font is not installed, and the file is loaded. Results are cached per family. |
| 2 | `server.py` `/avatars/`, `/assets/` | The browser percent-encodes the file name (`Ben%20W.png`) and the server never decoded it, so any speaker with a space in their name got a broken picture. | `unquote()` the path before touching the disk. The folder check now also requires a path separator after the directory. |
| 3 | `app.js` `undoLast` | Save, then undo: the unsaved flag was cleared whenever the undo stack emptied, even though the files on disk now differed from memory. Closing the editor then lost nothing visibly but left the mistake saved. | Undo always marks the project unsaved. |
| 4 | `app.js` `loadProject` | A `captions.json` that is not a list, or a card without `lines`, threw an uncaught `TypeError` past the `try` block. The Load button did nothing and no error was shown. | Validate the file (list of cards with numeric `start`/`end`), default missing `lines`, swap reversed `start`/`end`, and show a readable error on the setup screen. |
| 5 | `app.js` `loadProject` | Speakers from a speakers file or `settings.json` were trusted as-is. A missing `key` crashed `renderSpeakers`; an upper-case key never matched the lower-case comparison in the key handler; an invalid colour broke `hexToRgba` and could inject into a `style` attribute. | `normalizeSpeakers()`: keep only entries with a name, lower-case the key to one character, force a `#rrggbb` colour, drop duplicate names. |
| 6 | `app.js` `loadProject` | `loadSettings()` was fire-and-forget, so a slow first `/settings` response meant the built-in default roster instead of the remembered one. | `loadProject` awaits the settings promise. |
| 7 | `app.js` GIF search | The README says the search "starts with the caption's own words", but the box was only seeded when empty, so the second caption searched the previous caption's text. A slow earlier response could also overwrite a later query's results. | Always seed from the current caption; a sequence counter drops stale responses. |
| 8 | `app.js` `backToSetupBtn` | Open… hid the editor but left the video playing, so audio kept going behind the setup screen. | Pause the video. |
| 9 | `app.js` `loadWaveform` | The `AudioContext` was only closed on success. Chrome caps the number of contexts a page may hold, so repeated failed decodes eventually broke the waveform for the session. | Close in `finally`. |
| 10 | `app.js` `getFontIndex` | A failed `/fonts` fetch left the picker on "Reading installed fonts…" forever. | Catch and fall back to an empty list. |
| 11 | `app.js` `updateOverlay` | The preview's change key did not include the speaker's colour or font, so editing a speaker left the on-screen caption in the old colour until the caption changed. | Include colour and font in the key. |
| 12 | `app.js` `applyEditorText` | A legacy inline `*note*` pulled out of caption text replaced an existing `note` instead of joining it. | Join with `; `. |
| 13 | `app.js` `setFont` | The early-return compared against the raw file path while the stored value is `null` for renderer-known fonts, so re-picking the current font marked the project dirty. | Normalise before comparing. |
| 14 | `app.js` `loadProject` | Hidden timelines are written to the speakers file (`lanes[].hidden`) but were discarded on reopen, so they always came back visible. | Honour the saved flag; never allow every timeline to be hidden; the active timeline starts on the first visible one. **This is a behaviour change.** Revert that hunk if the old behaviour was intentional. |
| 15 | `server.py` `/fontfile` | A font file that had disappeared since the index was built raised an unhandled `OSError` (500 with a traceback). `.otf` files were labelled `font/ttf`. | 404 on `OSError`; label `.otf` correctly. |
| 16 | `server.py` `POST /settings` | A `settings.json` that is not an object, or non-dict entries in `speakers`, crashed the merge with a 500. | Tolerate both. |
| 17 | `server.py` `POST /avatar` | A non-numeric `Content-Length` raised an unhandled `ValueError`. | Treat as missing (400). |

## Noted, not changed

- **Avatar transparency.** `save_avatar_bytes` converts to RGB, so a PNG with a transparent background is
  saved on black. Switching to RGBA depends on what `render_captions.py` in video-editor expects of the
  file, so it was left alone.
- **Captions can land on a hidden timeline.** Arrow Up/Down and timeline drags compute the target lane by
  index and do not skip hidden lanes, so a caption can be moved somewhere it is not drawn.
- **Waveform memory.** `loadWaveform` reads the whole video into an `ArrayBuffer` and decodes it. Fine
  for shorts; a long source file will fail or stall the tab.
- **Stray avatar files.** A picture is uploaded the moment it is picked in the speaker dialog, so Cancel
  leaves a file in `avatars/`. Renaming a speaker leaves the old file behind too.
- **Workflow chart drift.** `docs/make_workflow.py` still mentions `captions.srt`, a "🕒+ Timeline"
  button and a "Caption font dropdown", and titles the chart "Caption Editor". Regenerating needs a
  text pass first.
- **`tray_launcher.ps1` kills by command-line match.** `Stop-OldServer` stops every `python.exe` whose
  command line contains this repo's `server.py` path. Correct for its purpose, just worth knowing if
  the repo is ever run from two checkouts.
- **`settings.json` is served whole.** `GET /settings` returns the GIPHY key to the page. Acceptable for
  a loopback-only server; it would matter if the bind address ever changed.

## Verification

- `node --check app.js` and `python -m py_compile server.py` pass.
- The patched server was run and probed: `GET /` (200), `/avatars/Ben%20W.png` (200), a `..%2F`
  traversal attempt (404), `/fontfile?i=999` (404), `POST /settings` with a junk speaker entry (200,
  existing `avatar` and `giphy_key` preserved), `POST /avatar` with `Content-Length: abc` (400).
- `normalizeSpeakers`, `applyEditorText` and `mergeRanges` were extracted and checked in Node.
- Not done: clicking through the editor in a browser. Loading a project needs the File System Access
  API dialogs, so the `app.js` changes are reviewed and syntax-checked but not exercised end to end.

---

# Round 2 — the features merged after the first pass

Reviewed: `1f4e14d` (composite queue, progress bar, log, notifications), `c4705e5` (FX presets, timeline
right-click, quick edit, leaving text boxes) and `fef21f6` (♥ default font). Fixes are in the commit that
adds this section.

## Fixed

| # | Where | Bug | Fix |
|---|---|---|---|
| 1 | `server.py` composite progress | Only the last 200 log lines were kept, and progress was recovered by scanning them for the `[step k/N]` line. One step prints far more than that (the frame counter, ffmpeg), so mid-step the bar fell to "0% starting…". Reproduced with 900 frame lines. | `note_line()` records the current step and frame fraction as lines arrive; `progress()` reads those. `GET /composite` returns `step` and the editor shows its label. |
| 2 | `style.css` top bar | With a caption box focused, the first click on Undo, Redo, Save, Ready for composite or Open… did nothing: the box blurs on mousedown, which hides "✓ Done typing", which reflows the row so the button slides out from under the pointer before mouseup. The dirty flag appearing on that same blur had the same effect. | Both keep their space when hidden (`visibility: hidden`) instead of leaving the flow. |
| 3 | `server.py` `run_composite` | The compositor ran under the server's own interpreter. The tray launcher falls back to plain `python` when the whisperx venv is missing, and then every composite failed on imports. | New `composite_python` setting (checked to exist at queue time); falls back to the server's interpreter. Documented in the README. |
| 4 | `server.py` `composite_worker` | If launching the compositor raised, the worker thread died with `alive` and `running` stuck true: later clips queued but never ran and the editor polled forever. | The launch is wrapped; a failure is logged and recorded as a finished job, and the queue continues. `_finished` is capped at 50. |
| 5 | `app.js` progress bar | `ok: null` (nothing finished yet) was rendered as "Failed (see log)", so the bar could flash red between queueing and the worker picking the job up. | Null is "Starting…"; only `ok === false` is a failure. |
| 6 | `app.js` polling | The page-load fetch started a poll loop without checking `polling`, so a second loop could run alongside the button's. | `startPolling()` is the single entry point. |
| 7 | `app.js` Escape | The timeline right-click menu and the FX popup stayed open on Escape. | Escape closes both. |

## Noted, not changed

- Quick edit pushes two undo steps when both the text and the notes change.
- The right-click menu stays where it was if the timeline scrolls under it (its actions still target the right caption).
- Quitting or restarting the server from the tray leaves a running compositor process to finish on its own; the fresh server knows nothing about it.
- The import-time `assert` that tested `progress()` is gone with the rewrite; the function is now covered by the checks run while making this change, not by anything in the repo.

## Verification

- `node --check app.js`, `python -m py_compile server.py`.
- `progress()` after a `[step 3/6]` line followed by 900 `frame a/b` lines and 300 ffmpeg-style lines: 0.5 (was 0.0 on `main`).
- Worker with a queue of two where the first launch raises: first recorded as failed, second runs, worker exits cleanly.
- Live server: `GET /composite` shape, a missing `composite_python` rejected with a message, and a fake compositor printing step and frame lines tracked to 50% mid-run and 1.0 with `ok: true` after.
- Not clicked through in a browser; the top-bar fix is reasoned from the layout, not observed.
