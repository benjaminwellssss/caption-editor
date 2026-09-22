# Caption Editor

A standalone, local browser app for correcting captions on a short-form video
while you watch it: who said each word, the text, the timing, emoji, and
instructions for the renderer. No install, no dependencies — Python's standard
library serves three static files; everything else runs in the browser.

**Run it:** double-click the **Caption Editor** desktop shortcut (a tray icon
starts the server; right-click it for Open / Restart / Quit), or
`python server.py` and open http://127.0.0.1:8765 in **Chrome or Edge**
(it needs the File System Access API for native file dialogs).
`install_shortcut.ps1` recreates the shortcut if the repo ever moves.

**Load:** pick the video, its `captions.json` (a list of timed cards) and,
optionally, a speakers file. Saving writes straight back to those same files.

## Typing in a caption's text box

| You type | It means |
|---|---|
| `*like this*` | An **editor note** — an instruction for whoever renders the video (for example `*gentle grow and vibrate*`). It is **never shown** in the video. Saved in the card's `note` field, kept out of `lines`. The row shows a 📝 chip; hover it to read the note. |
| `\|` | A **line break**. `HECK\|YES` puts YES on a second line under HECK. Saved as two entries in `lines`. |
| any emoji | Type it (Win + `.` opens Windows' emoji picker) or use the 😀 button on the row. |

A lone `*` with no closing `*` would show up in the video, so Save warns you.
A note is tidied to the end of the text after you commit it, and files that
older versions of the editor saved with `*note*` typed straight into the
caption are converted on load.

**What the renderer does with notes** lives in the video-editor pipeline
(`scripts/caption_fx.py`, used by `scripts/render_captions.py`): grow, zoom,
shake and vibrate, scaled by words like *gentle*, *very*, *extremely*,
*violent*. It prints what it understood for every note, or `NOT UNDERSTOOD`
for one it can't do, so nothing is silently ignored. Effects apply to the card
the note is on, and only to the captions — not the video.

## Timelines (simultaneous captions)

The **Timelines** panel above the caption list shows every caption as a block
on a time ruler, with a red playhead. It starts with one timeline;
**🕒+ Timeline** adds another lane, so captions can overlap in time — put a
second (third…) speaker on their own timeline and they show at the same moment.
In the video, **Timeline 1 is the big main caption** and each further timeline
stacks **smaller underneath** it (that's what the renderer draws, and what the
live preview shows). Each caption is colored by its speaker.

- **Slide:** drag a block left/right (it snaps to frames; hold **Alt** for free
  movement). Drag it up/down to move it to another timeline. With several
  captions selected, dragging any one moves them all together.
- **Resize:** drag a block's left or right edge.
- **Bump with the keyboard:** select caption(s) (click a block, or use the ☰
  handle in the list), then **←/→** moves them one frame (**Shift** = ten
  frames) and **↑/↓** moves them up/down a timeline. Holding a key is a single
  undo step.
- **Scrub:** click or drag on the ruler (or an empty part of a lane) to move the
  video there; a plain click on a block cues the video to its start.
- **Zoom:** the −/+ buttons, or **Ctrl**+mouse wheel.
- **Which timeline "+ Add caption" uses:** click a timeline's label (it turns
  blue). The **T1/T2…** menu on each list row also moves a caption between
  timelines. The **✕** on the last timeline's label removes it (its captions
  move up one).

## Controls

- **Space** play/pause · **<** / **>** back / forward 5 s · **Enter** restart
  (keeps all your edits) · **Backspace** undo the last action (when you're not
  typing in a box) · **Esc** clear the selection.
- **Speaker keys** (default: B Ben, J Jared, N Noah, A Brien, M Marlee,
  K Kat, T Tony, H Mitch — editable, with their colors) tag the current word,
  or the whole selection at once, and then clear the selection.
- **Selecting several words:** drag the ☰ handle, or click it and Shift-click
  another to extend, or Ctrl-click to add/remove one.
- **Each row:** ▶ seek there · editable start/end (seconds) · 😀 emoji ·
  **+** insert a blank caption after it · **✕** delete it. **+ Add caption**
  in the header inserts one at the playhead.
- **🔒 Following video / 🔓 Free scroll** toggles whether the list follows the
  playing word or stays where you scrolled it.

## File format

`captions.json` — a list of cards:

```json
{ "start": 5.89, "end": 7.31, "lines": ["🍑 KING!!"],
  "speaker": "Jared", "fill": [255, 214, 0, 255],
  "note": "gentle grow and vibrate of the text" }
```

`fill` (the speaker's color) is written from the speakers file each time you
save, so recoloring a speaker recolors all their words. `note` appears only on
cards that have one. `lane` (0-based; omitted for the main timeline) says which
timeline a caption is on — so a two-timeline file has some cards with
`"lane": 1`. Cards are saved sorted by start time. Unknown fields are passed
through untouched. (A timeline you've added but not put any caption on isn't
stored in the file, so it won't come back after a reload.)
