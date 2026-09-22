"use strict";

const FPS = 30;              // frame step for snapping and arrow-key bumps
const LABEL_W = 96;          // width of the lane-label column in the timeline (matches style.css)
const MAX_HISTORY = 10;      // how many undo/redo steps are kept

const state = {
  videoHandle: null,
  cardsHandle: null,
  speakersHandle: null, // may be null until first save, then remembered
  videoObjectUrl: null,
  // Kept sorted by (start, lane). Every card carries a runtime-only _id so
  // selection and undo survive re-sorting; _id is never saved.
  // {_id, start, end, lines:[text], lane?, speaker: name|null, fill?, note?}
  cards: [],
  speakers: [],    // [{name, key, color}]  color = "#rrggbb"
  undoStack: [],   // each entry: {undo(), redo(), ...bookkeeping} — capped at MAX_HISTORY
  redoStack: [],
  dirty: false,
  editingSpeakerIdx: null, // index into state.speakers, or null for "adding new"
  dragging: false,         // seek bar being dragged
  selection: new Set(),    // selected card _ids
  lastSelectedId: null,
  followVideo: true,       // list + timeline follow the playing word
  laneCount: 1,            // simultaneous-caption timelines (lane 0 = main)
  activeLane: 0,           // where "+ Add caption" puts a new caption
  pps: 80,                 // timeline zoom, pixels per second
};
let nextId = 1;

const $ = (sel) => document.querySelector(sel);
const video = () => $("#video");

// Pre-filled roster for a brand-new project (no existing speakers.json
// picked, or an empty one) — fully editable afterward, just a starting
// point so a fresh job doesn't start from zero.
const DEFAULT_SPEAKERS = [
  { name: "Ben", key: "b", color: "#8cff78" },
  { name: "Jared", key: "j", color: "#ffd600" },
  { name: "Noah", key: "n", color: "#ff4646" },
  { name: "Brien", key: "a", color: "#5aaaff" },
  { name: "Marlee", key: "m", color: "#b388ff" },
  { name: "Kat", key: "k", color: "#ff8ad8" },
  { name: "Tony", key: "t", color: "#ffa552" },
  { name: "Mitch", key: "h", color: "#b0b6c0" },
];

const HAS_FSA = "showOpenFilePicker" in window;
if (!HAS_FSA) $("#fsaWarning").classList.remove("hidden");

// ---------- utils ----------

function fmtTime(t) {
  if (!isFinite(t)) return "0:00";
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function hexToRgba(hex) {
  const h = hex.replace("#", "");
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return [r, g, b, 255];
}

function speakerByName(name) {
  return state.speakers.find((s) => s.name === name);
}

const laneOf = (card) => card.lane || 0;
const cardById = (id) => state.cards.find((c) => c._id === id);
const idxById = (id) => state.cards.findIndex((c) => c._id === id);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function sortCards() {
  state.cards.sort((a, b) => a.start - b.start || laneOf(a) - laneOf(b));
}

const orderKey = () => state.cards.map((c) => c._id).join(",");

// ---------- editor text syntax ----------
// What you type in a caption's text box:
//   *like this*  -> an editor note (instructions for whoever renders the
//                   video). Saved in card.note, never part of the caption.
//   |            -> a line break: "HECK|YES" shows HECK above YES.
// card.lines holds only what is displayed; card.note holds the notes.

function parseEditorText(raw) {
  const notes = [];
  const withoutNotes = raw.replace(/\*([^*]*)\*/g, (_, n) => {
    if (n.trim()) notes.push(n.trim());
    return " ";
  });
  const lines = withoutNotes.split("|").map((l) => l.replace(/\s+/g, " ").trim());
  while (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  while (lines.length > 1 && lines[0] === "") lines.shift();
  return { lines, note: notes.length ? notes.join("; ") : null };
}

function cardEditorText(card) {
  const shown = card.lines.join("|");
  return card.note ? `${shown} *${card.note}*` : shown;
}

function applyEditorText(card, raw) {
  const parsed = parseEditorText(raw);
  card.lines = parsed.lines;
  if (parsed.note) card.note = parsed.note;
  else delete card.note;
}

function markDirty(v = true) {
  state.dirty = v;
  $("#dirtyFlag").classList.toggle("hidden", !v);
}

async function ensureReadWrite(handle) {
  const opts = { mode: "readwrite" };
  if ((await handle.queryPermission(opts)) === "granted") return true;
  return (await handle.requestPermission(opts)) === "granted";
}

// ---------- native file pickers ----------

const JSON_TYPES = [{ description: "JSON", accept: { "application/json": [".json"] } }];
const VIDEO_TYPES = [{ description: "Video", accept: { "video/*": [".mp4", ".mov", ".mkv", ".webm"] } }];

document.querySelectorAll("[data-pick]").forEach((btn) => {
  btn.addEventListener("click", () => pickFile(btn.dataset.pick));
});

async function pickFile(target) {
  if (!("showOpenFilePicker" in window)) {
    alert("Native file picking needs Chrome or Edge on Windows.");
    return;
  }
  const types = target === "video" ? VIDEO_TYPES : JSON_TYPES;
  try {
    const [handle] = await window.showOpenFilePicker({ types, multiple: false });
    if (target === "video") state.videoHandle = handle;
    else if (target === "cards") state.cardsHandle = handle;
    else state.speakersHandle = handle;
    const label = $(`#${target}PathLabel`);
    label.textContent = handle.name;
    label.classList.add("chosen");
  } catch (e) {
    if (e.name !== "AbortError") console.error(e);
  }
}

// ---------- load project ----------

$("#loadBtn").addEventListener("click", loadProject);

async function loadProject() {
  const errEl = $("#setupError");
  errEl.textContent = "";

  if (!state.videoHandle || !state.cardsHandle) {
    errEl.textContent = "Choose both a video file and a captions (cards.json) file.";
    return;
  }

  let cards;
  try {
    const cardsFile = await state.cardsHandle.getFile();
    cards = JSON.parse(await cardsFile.text());
  } catch (e) {
    errEl.textContent = "Could not read/parse cards.json: " + e.message;
    return;
  }

  let speakers = [];
  if (state.speakersHandle) {
    try {
      const spFile = await state.speakersHandle.getFile();
      speakers = JSON.parse(await spFile.text());
    } catch (e) {
      errEl.textContent = "Could not read/parse speakers.json: " + e.message;
      return;
    }
  }
  if (speakers.length === 0) {
    speakers = DEFAULT_SPEAKERS.map((s) => ({ ...s }));
  }

  if (!(await ensureReadWrite(state.cardsHandle))) {
    errEl.textContent = "Write permission for cards.json was denied — can't save changes.";
    return;
  }

  // Files saved by an older version of this editor can have "*note*" typed
  // straight into the caption text — pull those out into card.note now.
  let migrated = false;
  state.cards = cards.map((c) => {
    const card = { ...c, _id: nextId++, lines: [...c.lines], speaker: c.speaker || null };
    if (card.lane) card.lane = Math.max(0, Math.floor(card.lane)); else delete card.lane;
    const before = JSON.stringify([card.lines, card.note || null]);
    applyEditorText(card, cardEditorText(card));
    if (JSON.stringify([card.lines, card.note || null]) !== before) migrated = true;
    return card;
  });
  sortCards();
  state.laneCount = Math.max(1, ...state.cards.map((c) => laneOf(c) + 1));
  state.activeLane = 0;
  state.speakers = speakers;
  state.undoStack = [];
  state.redoStack = [];
  state.selection = new Set();
  state.lastSelectedId = null;
  markDirty(migrated);
  updateHistoryButtons();

  if (state.videoObjectUrl) URL.revokeObjectURL(state.videoObjectUrl);
  const videoFile = await state.videoHandle.getFile();
  state.videoObjectUrl = URL.createObjectURL(videoFile);
  video().src = state.videoObjectUrl;

  $("#projectLabel").textContent =
    `${videoFile.name}  —  ${state.cardsHandle.name}  —  speakers: ${state.speakersHandle ? state.speakersHandle.name : "(not yet created)"}`;

  $("#setup").classList.add("hidden");
  $("#editor").classList.remove("hidden");

  renderSpeakers();
  renderWords();
  renderTimeline();
  renderSelectionStatus();
}

$("#backToSetupBtn").addEventListener("click", () => {
  if (state.dirty && !confirm("You have unsaved changes. Discard and load different files?")) return;
  $("#editor").classList.add("hidden");
  $("#setup").classList.remove("hidden");
});

video().addEventListener("loadedmetadata", () => renderTimeline());

// ---------- speakers panel ----------

function renderSpeakers() {
  const list = $("#speakersList");
  list.innerHTML = "";
  state.speakers.forEach((sp, idx) => {
    const chip = document.createElement("div");
    chip.className = "speaker-chip";
    chip.innerHTML = `<span class="swatch" style="background:${sp.color}"></span>
      <span class="key">${sp.key.toUpperCase()}</span> ${sp.name}`;
    chip.onclick = () => openSpeakerModal(idx);
    list.appendChild(chip);
  });
}

$("#addSpeakerBtn").addEventListener("click", () => openSpeakerModal(null));

function openSpeakerModal(idx) {
  state.editingSpeakerIdx = idx;
  const isNew = idx === null;
  $("#speakerModalTitle").textContent = isNew ? "Add speaker" : "Edit speaker";
  $("#spName").value = isNew ? "" : state.speakers[idx].name;
  $("#spKey").value = isNew ? "" : state.speakers[idx].key;
  $("#spColor").value = isNew ? randomColor() : state.speakers[idx].color;
  $("#spDelete").classList.toggle("hidden", isNew);
  $("#speakerFormError").textContent = "";
  $("#speakerModal").classList.remove("hidden");
  $("#spName").focus();
}

function randomColor() {
  const palette = ["#8cff78", "#ffd600", "#ff4646", "#5aaaff", "#ff9de2", "#ffa552", "#9d7bff"];
  return palette[state.speakers.length % palette.length];
}

function closeSpeakerModal() {
  $("#speakerModal").classList.add("hidden");
  // A display:none ancestor doesn't auto-blur a focused descendant input in
  // every browser — left unblurred, isTypingTarget() would keep treating
  // the (now hidden) field as focused and silently swallow every hotkey.
  if (document.activeElement && document.activeElement !== document.body) {
    document.activeElement.blur();
  }
}

$("#speakerModalClose").addEventListener("click", closeSpeakerModal);
$("#spCancel").addEventListener("click", closeSpeakerModal);

$("#spSave").addEventListener("click", () => {
  const name = $("#spName").value.trim();
  const key = $("#spKey").value.trim().toLowerCase();
  const color = $("#spColor").value;
  const errEl = $("#speakerFormError");

  if (!name) { errEl.textContent = "Name is required."; return; }
  if (!key || key.length !== 1) { errEl.textContent = "Hotkey must be a single character."; return; }
  const RESERVED = [" ", "enter", "backspace", "<", ">", ",", ".", "escape"];
  if (RESERVED.includes(key)) { errEl.textContent = "That key is reserved for playback controls."; return; }

  const dupe = state.speakers.find((s, i) => s.key === key && i !== state.editingSpeakerIdx);
  if (dupe) { errEl.textContent = `"${key}" is already used by ${dupe.name}.`; return; }

  const nameDupe = state.speakers.find((s, i) => s.name === name && i !== state.editingSpeakerIdx);
  if (nameDupe) { errEl.textContent = `A speaker named "${name}" already exists.`; return; }

  if (state.editingSpeakerIdx === null) {
    const newSp = { name, key, color };
    state.speakers.push(newSp);
    pushUndo({
      undo: () => {
        const i = state.speakers.indexOf(newSp);
        if (i >= 0) state.speakers.splice(i, 1);
        renderSpeakers(); renderWords(); renderTimeline();
      },
      redo: () => {
        state.speakers.push(newSp);
        renderSpeakers(); renderWords(); renderTimeline();
      },
    });
  } else {
    const idx = state.editingSpeakerIdx;
    const oldSp = { ...state.speakers[idx] };
    const oldName = oldSp.name;
    const newSp = { name, key, color };
    const renamed = oldName !== name;
    const renamedIds = renamed ? state.cards.filter((c) => c.speaker === oldName).map((c) => c._id) : [];
    state.speakers[idx] = newSp;
    if (renamed) renamedIds.forEach((id) => { const c = cardById(id); if (c) c.speaker = name; });
    pushUndo({
      undo: () => {
        state.speakers[idx] = oldSp;
        if (renamed) renamedIds.forEach((id) => { const c = cardById(id); if (c) c.speaker = oldName; });
        renderSpeakers(); renderWords(); renderTimeline();
      },
      redo: () => {
        state.speakers[idx] = newSp;
        if (renamed) renamedIds.forEach((id) => { const c = cardById(id); if (c) c.speaker = name; });
        renderSpeakers(); renderWords(); renderTimeline();
      },
    });
  }
  markDirty();
  renderSpeakers();
  renderWords();
  renderTimeline();
  closeSpeakerModal();
});

$("#spDelete").addEventListener("click", () => {
  if (state.editingSpeakerIdx === null) return;
  const idx = state.editingSpeakerIdx;
  const sp = state.speakers[idx];
  if (!confirm(`Delete speaker "${sp.name}"? Words already tagged with them will show as unassigned.`)) return;
  state.speakers.splice(idx, 1);
  pushUndo({
    undo: () => {
      state.speakers.splice(idx, 0, sp);
      renderSpeakers(); renderWords(); renderTimeline();
    },
    redo: () => {
      const i = state.speakers.indexOf(sp);
      if (i >= 0) state.speakers.splice(i, 1);
      renderSpeakers(); renderWords(); renderTimeline();
    },
  });
  markDirty();
  renderSpeakers();
  renderWords();
  renderTimeline();
  closeSpeakerModal();
});

// ---------- follow-video toggle ----------

$("#followToggle").addEventListener("click", () => {
  state.followVideo = !state.followVideo;
  const btn = $("#followToggle");
  btn.textContent = state.followVideo ? "🔒 Following video" : "🔓 Free scroll";
  btn.classList.toggle("unlocked", !state.followVideo);
});

// ---------- words panel ----------

function renderWords() {
  const list = $("#wordsList");
  const savedScroll = list.scrollTop;
  list.innerHTML = "";
  list.classList.toggle("single-lane", state.laneCount <= 1);
  state.cards.forEach((card) => list.appendChild(buildRow(card)));
  list.scrollTop = savedScroll;
}

function buildRow(card) {
  const id = card._id;
  const row = document.createElement("div");
  row.className = "word-row" + (state.selection.has(id) ? " selected" : "");
  row.dataset.id = id;

  const handle = document.createElement("span");
  handle.className = "row-handle";
  handle.textContent = "☰";
  handle.title = "Click to select — drag for a range, Shift-click to extend, Ctrl-click to add/remove one";
  handle.addEventListener("mousedown", (e) => onHandleMouseDown(e, id));
  handle.addEventListener("mouseenter", () => onHandleMouseEnter(id));

  const seekBtn = document.createElement("button");
  seekBtn.className = "seek-btn";
  seekBtn.textContent = "▶";
  seekBtn.title = "Jump video to this word's start";
  seekBtn.addEventListener("click", (e) => { e.stopPropagation(); video().currentTime = card.start; });

  const startInput = document.createElement("input");
  startInput.type = "number";
  startInput.step = "0.01";
  startInput.className = "time-input start-time";
  startInput.value = card.start.toFixed(3);
  startInput.title = "Start time (seconds)";
  startInput.addEventListener("click", (e) => e.stopPropagation());
  startInput.addEventListener("change", () => {
    const next = parseFloat(startInput.value);
    if (isNaN(next) || next < 0 || next >= card.end) { startInput.value = card.start.toFixed(3); return; }
    applyMove([{ card, start: next, end: card.end, lane: laneOf(card) }], "edit");
  });

  const sep = document.createElement("span");
  sep.className = "time-sep";
  sep.textContent = "–";

  const endInput = document.createElement("input");
  endInput.type = "number";
  endInput.step = "0.01";
  endInput.className = "time-input end-time";
  endInput.value = card.end.toFixed(3);
  endInput.title = "End time (seconds)";
  endInput.addEventListener("click", (e) => e.stopPropagation());
  endInput.addEventListener("change", () => {
    const next = parseFloat(endInput.value);
    if (isNaN(next) || next <= card.start) { endInput.value = card.end.toFixed(3); return; }
    applyMove([{ card, start: card.start, end: next, lane: laneOf(card) }], "edit");
  });

  const text = document.createElement("input");
  text.className = "text";
  text.type = "text";
  text.value = cardEditorText(card);
  text.title = "*note* = editor note (not shown in the video)   |  = line break";
  text.addEventListener("click", (e) => e.stopPropagation());
  text.addEventListener("change", () => {
    const prev = cardEditorText(card);
    const next = text.value;
    if (prev === next) return;
    applyEditorText(card, next);
    text.value = cardEditorText(card); // show the canonical form (notes tidied to the end)
    const canonical = text.value;
    pushUndo({
      undo: () => { const c = cardById(id); if (c) { applyEditorText(c, prev); refreshRow(c); } },
      redo: () => { const c = cardById(id); if (c) { applyEditorText(c, canonical); refreshRow(c); } },
    });
    updateNoteChip(row, card);
    updateBlock(card);
    markDirty();
  });

  const noteChip = document.createElement("span");
  noteChip.className = "note-chip hidden";

  const badge = document.createElement("span");
  badge.className = "speaker-badge";

  const laneSel = document.createElement("select");
  laneSel.className = "lane-select";
  laneSel.title = "Which timeline this caption is on (simultaneous captions)";
  for (let i = 0; i < state.laneCount; i++) {
    const o = document.createElement("option");
    o.value = i;
    o.textContent = `T${i + 1}`;
    laneSel.appendChild(o);
  }
  laneSel.value = String(laneOf(card));
  laneSel.addEventListener("change", () => {
    const lane = parseInt(laneSel.value, 10);
    laneSel.blur();
    applyMove([{ card, start: card.start, end: card.end, lane }], "edit");
  });

  const emojiBtn = document.createElement("button");
  emojiBtn.className = "row-icon-btn";
  emojiBtn.textContent = "😀";
  emojiBtn.title = "Insert emoji";
  emojiBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    openEmojiPicker(emojiBtn, text);
  });

  const insertBtn = document.createElement("button");
  insertBtn.className = "row-icon-btn";
  insertBtn.textContent = "+";
  insertBtn.title = "Insert a new blank caption after this one";
  insertBtn.addEventListener("click", (e) => { e.stopPropagation(); insertCardAfter(id); });

  const deleteBtn = document.createElement("button");
  deleteBtn.className = "row-icon-btn danger";
  deleteBtn.textContent = "✕";
  deleteBtn.title = "Delete this caption";
  deleteBtn.addEventListener("click", (e) => { e.stopPropagation(); deleteCard(id); });

  [handle, seekBtn, startInput, sep, endInput, text, noteChip, badge, laneSel, emojiBtn, insertBtn, deleteBtn]
    .forEach((el) => row.appendChild(el));
  updateNoteChip(row, card);
  updateBadge(row, card);
  return row;
}

function updateNoteChip(row, card) {
  if (!row) return;
  const chip = row.querySelector(".note-chip");
  chip.classList.toggle("hidden", !card.note);
  chip.textContent = card.note ? "📝 note" : "";
  chip.title = card.note || "";
}

function updateBadge(row, card) {
  const badge = row.querySelector(".speaker-badge");
  badge.textContent = card.speaker || "—";
  badge.className = "speaker-badge" + (card.speaker ? "" : " unassigned");
  const sp = card.speaker ? speakerByName(card.speaker) : null;
  if (sp) { badge.style.background = sp.color; badge.style.color = "#101215"; }
  else { badge.style.background = ""; badge.style.color = ""; }
}

const rowOf = (id) => $(`.word-row[data-id="${id}"]`);

// Refresh everything shown for one card in the list and the timeline.
function refreshRow(card, flash = true) {
  const row = rowOf(card._id);
  if (row) {
    row.querySelector(".text").value = cardEditorText(card);
    updateNoteChip(row, card);
    updateBadge(row, card);
    row.querySelector(".start-time").value = card.start.toFixed(3);
    row.querySelector(".end-time").value = card.end.toFixed(3);
    row.querySelector(".lane-select").value = String(laneOf(card));
    if (flash) {
      row.classList.add("flash");
      setTimeout(() => row.classList.remove("flash"), 500);
    }
  }
  updateBlock(card);
}

// ---------- insert / delete captions ----------

function addCard(card, focus = true) {
  card._id = nextId++;
  state.cards.push(card);
  sortCards();
  pushUndo({
    undo: () => {
      const i = idxById(card._id);
      if (i >= 0) state.cards.splice(i, 1);
      clearSelection(); renderWords(); renderTimeline();
    },
    redo: () => {
      state.cards.push(card);
      sortCards();
      clearSelection(); renderWords(); renderTimeline();
    },
  });
  markDirty();
  clearSelection();
  renderWords();
  renderTimeline();
  const row = rowOf(card._id);
  if (row && focus) {
    row.scrollIntoView({ block: "center" });
    row.querySelector(".text").focus();
  }
}

// Room before the next caption *on the same timeline*, so a new caption
// doesn't land on top of a neighbour.
function nextStartInLane(lane, after) {
  const nxt = state.cards.find((c) => laneOf(c) === lane && c.start > after);
  return nxt ? nxt.start : Infinity;
}

function insertCardAfter(id) {
  const card = cardById(id);
  const lane = laneOf(card);
  const start = card.end;
  let end = Math.min(start + 0.3, nextStartInLane(lane, card.start));
  end = Math.max(end, start + 0.05);
  addCard({ start, end, lines: [""], speaker: null, ...(lane ? { lane } : {}) });
}

function insertCardAtTime(t) {
  const lane = state.activeLane;
  let end = Math.min(t + 0.3, nextStartInLane(lane, t));
  end = Math.max(end, t + 0.05);
  addCard({ start: t, end, lines: [""], speaker: null, ...(lane ? { lane } : {}) });
}

function deleteCard(id) {
  const idx = idxById(id);
  if (idx < 0) return;
  const [removed] = state.cards.splice(idx, 1);
  pushUndo({
    undo: () => {
      state.cards.push(removed);
      sortCards();
      clearSelection(); renderWords(); renderTimeline();
    },
    redo: () => {
      const i = idxById(removed._id);
      if (i >= 0) state.cards.splice(i, 1);
      clearSelection(); renderWords(); renderTimeline();
    },
  });
  markDirty();
  clearSelection();
  renderWords();
  renderTimeline();
}

$("#addCaptionBtn").addEventListener("click", () => insertCardAtTime(video().currentTime));

// ---------- emoji picker ----------

const EMOJI_SET = [
  "😀", "😂", "😭", "😱", "😡", "🤔", "😴", "😎", "🥵", "🥶", "😈", "👀",
  "💀", "🔥", "💯", "👍", "👎", "👏", "🙌", "🤝", "🙏", "💪", "🤡", "🎮",
  "🎉", "🎂", "🍻", "🍺", "💰", "🪓", "⚔️", "🛡️", "🏆", "⭐", "✨", "💥",
  "⚡", "❤️", "💚", "💛", "💙", "💜", "🖤", "🤍", "🚫", "❌", "✅", "❓",
  "❗", "😅", "🤯", "🫡", "🍑",
];

const emojiPickerEl = $("#emojiPicker");
let emojiTargetInput = null;

EMOJI_SET.forEach((em) => {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = em;
  btn.addEventListener("click", (e) => { e.stopPropagation(); insertEmoji(em); });
  emojiPickerEl.appendChild(btn);
});

function openEmojiPicker(triggerBtn, targetInput) {
  emojiTargetInput = targetInput;
  const rect = triggerBtn.getBoundingClientRect();
  emojiPickerEl.style.left = Math.min(rect.left, window.innerWidth - 290) + "px";
  emojiPickerEl.style.top = (rect.bottom + 4) + "px";
  emojiPickerEl.classList.remove("hidden");
}

function closeEmojiPicker() {
  emojiPickerEl.classList.add("hidden");
  emojiTargetInput = null;
}

function insertEmoji(em) {
  if (!emojiTargetInput) return;
  const input = emojiTargetInput;
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? input.value.length;
  input.value = input.value.slice(0, start) + em + input.value.slice(end);
  const newPos = start + em.length;
  input.focus();
  input.setSelectionRange(newPos, newPos);
  // reuses the existing "change" listener's prev/next diff + undo push
  input.dispatchEvent(new Event("change", { bubbles: true }));
  closeEmojiPicker();
}

document.addEventListener("click", (e) => {
  if (!emojiPickerEl.classList.contains("hidden") && !emojiPickerEl.contains(e.target)) {
    closeEmojiPicker();
  }
});

// ---------- selection (shared by the list and the timeline) ----------

function setSelection(ids, lastId = null) {
  state.selection = new Set(ids);
  state.lastSelectedId = lastId;
  applySelectionClasses();
  renderSelectionStatus();
}

function applySelectionClasses() {
  document.querySelectorAll(".word-row, .tl-block").forEach((el) => {
    el.classList.toggle("selected", state.selection.has(parseInt(el.dataset.id, 10)));
  });
}

function renderSelectionStatus() {
  const el = $("#selectionStatus");
  if (state.selection.size > 1) {
    el.textContent = `${state.selection.size} captions selected — a speaker key tags them all, ←/→ bump their timing, drag any of them on the timeline, Esc to clear`;
    el.classList.remove("hidden");
  } else {
    el.classList.add("hidden");
  }
}

function clearSelection() {
  setSelection([], null);
}

// ---------- list drag-to-select (via the row-handle grip only, never the
// text or times, so a selection drag can't turn into a native text
// selection or collide with editing/seeking) ----------

let dragAnchorPos = null; // position in state.cards (sorted order)
let dragAdditive = false;
let dragBaseSelection = null;

function onHandleMouseDown(e, id) {
  e.preventDefault(); // stop the drag from starting a native text selection
  const pos = idxById(id);
  const lastPos = state.lastSelectedId === null ? -1 : idxById(state.lastSelectedId);
  if (e.shiftKey && lastPos >= 0) {
    dragAnchorPos = lastPos;
    dragAdditive = false;
    dragBaseSelection = null;
    applyDragRange(pos);
  } else if (e.ctrlKey || e.metaKey) {
    const next = new Set(state.selection);
    if (next.has(id)) next.delete(id); else next.add(id);
    dragAnchorPos = pos;
    dragAdditive = true;
    dragBaseSelection = new Set(next);
    setSelection(next, id);
  } else {
    dragAnchorPos = pos;
    dragAdditive = false;
    dragBaseSelection = null;
    setSelection([id], id);
  }
}

function onHandleMouseEnter(id) {
  if (dragAnchorPos === null) return; // not mid-drag
  applyDragRange(idxById(id));
}

function applyDragRange(pos) {
  const [lo, hi] = dragAnchorPos <= pos ? [dragAnchorPos, pos] : [pos, dragAnchorPos];
  const next = dragAdditive ? new Set(dragBaseSelection) : new Set();
  for (let i = lo; i <= hi; i++) next.add(state.cards[i]._id);
  setSelection(next, state.cards[pos]._id);
}

document.addEventListener("mouseup", () => {
  dragAnchorPos = null;
  dragBaseSelection = null;
});

// ---------- moving captions (timeline drag, arrow keys, list edits) ----------
// Every change to a caption's start/end/lane goes through applyMove so it is
// undoable, keeps the list sorted, and updates the timeline.

// Re-applies a set of {id, start, end, lane} snapshots — shared by every
// undo/redo closure that reverts or reapplies a timing change.
function applyItemSnapshots(items) {
  const cs = [];
  items.forEach((it) => {
    const c = cardById(it.id);
    if (!c) return;
    c.start = it.start;
    c.end = it.end;
    if (it.lane) c.lane = it.lane; else delete c.lane;
    cs.push(c);
  });
  afterTimingChange(cs);
}

// changes: [{card, start, end, lane}]. kind: "edit" | "drag" | "nudge".
function applyMove(changes, kind) {
  const prevItems = [];
  const nextItems = [];
  const changed = [];
  for (const ch of changes) {
    const c = ch.card;
    if (c.start === ch.start && c.end === ch.end && laneOf(c) === ch.lane) continue;
    prevItems.push({ id: c._id, start: c.start, end: c.end, lane: laneOf(c) });
    nextItems.push({ id: c._id, start: ch.start, end: ch.end, lane: ch.lane });
    c.start = ch.start;
    c.end = ch.end;
    if (ch.lane) c.lane = ch.lane; else delete c.lane;
    changed.push(c);
  }
  if (!changed.length) return;

  const mergeKey = prevItems.map((i) => i.id).join(",");
  const last = state.undoStack[state.undoStack.length - 1];
  if (kind === "nudge" && last && last._nudgeKey === mergeKey && Date.now() - last._t < 900) {
    // holding an arrow key is one undo step, not thirty — keep the original
    // undo (back to before the hold began), just extend what redo replays
    last._t = Date.now();
    last.redo = () => applyItemSnapshots(nextItems);
  } else {
    pushUndo({
      _nudgeKey: kind === "nudge" ? mergeKey : undefined,
      _t: Date.now(),
      undo: () => applyItemSnapshots(prevItems),
      redo: () => applyItemSnapshots(nextItems),
    });
  }
  markDirty();
  afterTimingChange(changed);
}

function afterTimingChange(changed) {
  const before = orderKey();
  sortCards();
  if (before !== orderKey()) renderWords();
  else changed.forEach((c) => refreshRow(c, false));
  renderTimeline();
}

// Bump the selected captions by dt seconds and/or dl lanes. Returns whether
// anything was selected.
function nudgeSelection(dt, dl) {
  const cards = [...state.selection].map(cardById).filter(Boolean);
  if (!cards.length) return false;
  const minStart = Math.min(...cards.map((c) => c.start));
  const t = Math.max(dt, -minStart);
  const minLane = Math.min(...cards.map(laneOf));
  const maxLane = Math.max(...cards.map(laneOf));
  const l = clamp(dl, -minLane, state.laneCount - 1 - maxLane);
  applyMove(cards.map((c) => ({
    card: c, start: c.start + t, end: c.end + t, lane: laneOf(c) + l,
  })), "nudge");
  return true;
}

// ---------- timelines (lanes) ----------

const tlScroll = () => $("#tlScroll");
const tlContent = () => $("#tlContent");

function timelineSeconds() {
  const d = video().duration;
  const maxEnd = state.cards.reduce((m, c) => Math.max(m, c.end), 0);
  return Math.max(isFinite(d) ? d : 0, maxEnd) + 1;
}

function renderTimeline() {
  const scroll = tlScroll();
  const sl = scroll.scrollLeft, st = scroll.scrollTop;
  const content = tlContent();
  content.innerHTML = "";
  const width = Math.ceil(timelineSeconds() * state.pps);
  content.style.width = (LABEL_W + width) + "px";

  // ruler
  const rulerRow = document.createElement("div");
  rulerRow.className = "tl-row tl-ruler-row";
  const corner = document.createElement("div");
  corner.className = "tl-label tl-corner";
  const ruler = document.createElement("div");
  ruler.className = "tl-ruler";
  ruler.style.width = width + "px";
  const step = state.pps >= 60 ? 1 : state.pps >= 25 ? 5 : 10;
  for (let s = 0; s * state.pps <= width; s += step) {
    const tick = document.createElement("div");
    tick.className = "tl-tick";
    tick.style.left = s * state.pps + "px";
    tick.textContent = fmtTime(s);
    ruler.appendChild(tick);
  }
  ruler.addEventListener("mousedown", (e) => startScrub(e, ruler));
  rulerRow.append(corner, ruler);
  content.appendChild(rulerRow);

  // lanes
  for (let lane = 0; lane < state.laneCount; lane++) {
    const row = document.createElement("div");
    row.className = "tl-row";
    const label = document.createElement("div");
    label.className = "tl-label" + (lane === state.activeLane ? " active" : "");
    label.textContent = lane === 0 ? "Timeline 1" : `Timeline ${lane + 1}`;
    label.title = "Click to make this the timeline “+ Add caption” uses";
    label.addEventListener("click", () => { state.activeLane = lane; renderTimeline(); });
    if (lane > 0 && lane === state.laneCount - 1) {
      const rm = document.createElement("button");
      rm.className = "tl-lane-remove";
      rm.textContent = "✕";
      rm.title = "Remove this timeline";
      rm.addEventListener("click", (e) => { e.stopPropagation(); removeLastLane(); });
      label.appendChild(rm);
    }
    const track = document.createElement("div");
    track.className = "tl-lane-track";
    track.dataset.lane = lane;
    track.style.width = width + "px";
    track.addEventListener("mousedown", (e) => {
      if (e.target !== track) return;
      state.activeLane = lane;
      clearSelection();
      startScrub(e, track);
      document.querySelectorAll(".tl-label").forEach((l, i) => l.classList.toggle("active", i - 1 === lane));
    });
    state.cards.forEach((card) => { if (Math.min(laneOf(card), state.laneCount - 1) === lane) track.appendChild(makeBlock(card)); });
    row.append(label, track);
    content.appendChild(row);
  }

  const ph = document.createElement("div");
  ph.id = "tlPlayhead";
  ph.className = "tl-playhead";
  content.appendChild(ph);
  scroll.scrollLeft = sl;
  scroll.scrollTop = st;
  placePlayhead();
  renderOverlayLanes();
}

function blockColors(card) {
  const sp = card.speaker ? speakerByName(card.speaker) : null;
  return sp ? { bg: sp.color, fg: "#101215" } : { bg: "#4b5468", fg: "#f1f3f7" };
}

function makeBlock(card) {
  const b = document.createElement("div");
  b.className = "tl-block" + (state.selection.has(card._id) ? " selected" : "");
  b.dataset.id = card._id;
  const hl = document.createElement("i");
  hl.className = "tl-h tl-hl";
  const hr = document.createElement("i");
  hr.className = "tl-h tl-hr";
  const label = document.createElement("span");
  label.className = "tl-text";
  b.append(hl, label, hr);
  b.addEventListener("mousedown", (e) => onBlockMouseDown(e, card._id));
  positionBlock(b, card);
  return b;
}

function positionBlock(b, card) {
  const { bg, fg } = blockColors(card);
  b.style.left = card.start * state.pps + "px";
  b.style.width = Math.max(6, (card.end - card.start) * state.pps) + "px";
  b.style.background = bg;
  b.style.color = fg;
  b.title = `${card.lines.join(" / ")}\n${card.start.toFixed(2)}s – ${card.end.toFixed(2)}s` +
    (card.note ? `\n📝 ${card.note}` : "");
  b.querySelector(".tl-text").textContent = card.lines.join(" / ") + (card.note ? " 📝" : "");
}

function updateBlock(card) {
  const b = $(`.tl-block[data-id="${card._id}"]`);
  if (b) positionBlock(b, card);
}

function laneAtY(clientY) {
  const tracks = [...document.querySelectorAll(".tl-lane-track")];
  for (let i = 0; i < tracks.length; i++) {
    if (clientY < tracks[i].getBoundingClientRect().bottom) return i;
  }
  return Math.max(0, tracks.length - 1);
}

function placePlayhead() {
  const ph = $("#tlPlayhead");
  if (ph) ph.style.left = (LABEL_W + video().currentTime * state.pps) + "px";
}

// -- ruler / empty-lane scrubbing --

let scrubbing = null;
function startScrub(e, el) {
  if (e.button !== 0) return;
  e.preventDefault();
  scrubbing = el;
  scrubTo(e.clientX);
}
function scrubTo(clientX) {
  if (!scrubbing) return;
  const rect = scrubbing.getBoundingClientRect();
  const dur = video().duration;
  const t = clamp((clientX - rect.left) / state.pps, 0, isFinite(dur) ? dur : Infinity);
  video().currentTime = t;
  placePlayhead();
}

// -- dragging captions on the timeline --

let tlDrag = null;
const DRAG_THRESHOLD_PX = 3;

function onBlockMouseDown(e, id) {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  const card = cardById(id);
  const edge = e.target.classList.contains("tl-hl") ? "l" : e.target.classList.contains("tl-hr") ? "r" : null;

  let collapseOnClick = false;
  if (e.ctrlKey || e.metaKey) {
    const next = new Set(state.selection);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelection(next, id);
  } else if (e.shiftKey && state.lastSelectedId !== null && idxById(state.lastSelectedId) >= 0) {
    const [lo, hi] = [idxById(state.lastSelectedId), idxById(id)].sort((a, b) => a - b);
    setSelection(state.cards.slice(lo, hi + 1).map((c) => c._id), id);
  } else if (!state.selection.has(id)) {
    setSelection([id], id);
  } else {
    collapseOnClick = state.selection.size > 1 && !edge; // click (no drag) on a group member picks just it
    state.lastSelectedId = id;
  }
  state.activeLane = laneOf(card);

  const movers = edge ? [card] : [...state.selection].map(cardById).filter(Boolean);
  tlDrag = {
    id, edge, collapseOnClick, moved: false,
    startX: e.clientX, grabLane: laneOf(card),
    orig: new Map(movers.map((c) => [c._id, { start: c.start, end: c.end, lane: laneOf(c) }])),
  };
}

document.addEventListener("mousemove", (e) => {
  if (scrubbing) { scrubTo(e.clientX); return; }
  if (!tlDrag) return;
  const dx = e.clientX - tlDrag.startX;
  if (!tlDrag.moved && Math.abs(dx) < DRAG_THRESHOLD_PX && laneAtY(e.clientY) === tlDrag.grabLane) return;
  tlDrag.moved = true;

  let dt = dx / state.pps;
  if (!e.altKey) dt = Math.round(dt * FPS) / FPS; // snap to frames; Alt = free
  const ids = [...tlDrag.orig.keys()];
  const origs = [...tlDrag.orig.values()];

  if (tlDrag.edge) {
    const c = cardById(ids[0]), o = origs[0];
    if (tlDrag.edge === "l") c.start = clamp(o.start + dt, 0, o.end - 0.05);
    else c.end = Math.max(o.start + 0.05, o.end + dt);
    updateBlock(c);
    const row = rowOf(c._id);
    if (row) {
      row.querySelector(".start-time").value = c.start.toFixed(3);
      row.querySelector(".end-time").value = c.end.toFixed(3);
    }
    return;
  }

  const t = Math.max(dt, -Math.min(...origs.map((o) => o.start)));
  const dl = clamp(laneAtY(e.clientY) - tlDrag.grabLane,
    -Math.min(...origs.map((o) => o.lane)),
    state.laneCount - 1 - Math.max(...origs.map((o) => o.lane)));
  ids.forEach((id) => {
    const c = cardById(id), o = tlDrag.orig.get(id);
    c.start = o.start + t;
    c.end = o.end + t;
    const lane = o.lane + dl;
    if (lane) c.lane = lane; else delete c.lane;
    let b = $(`.tl-block[data-id="${id}"]`);
    positionBlock(b, c);
    const track = document.querySelector(`.tl-lane-track[data-lane="${lane}"]`);
    if (track && b.parentElement !== track) track.appendChild(b);
    const row = rowOf(id);
    if (row) {
      row.querySelector(".start-time").value = c.start.toFixed(3);
      row.querySelector(".end-time").value = c.end.toFixed(3);
    }
  });
});

document.addEventListener("mouseup", () => {
  scrubbing = null;
  if (!tlDrag) return;
  const d = tlDrag;
  tlDrag = null;
  if (!d.moved) {
    if (d.collapseOnClick) setSelection([d.id], d.id);
    const c = cardById(d.id);
    if (c) { video().currentTime = c.start; placePlayhead(); } // a plain click also cues the video there
    return;
  }
  // Commit the drag as a single undo step, from the positions before it began.
  const changed = [];
  const prevItems = [];
  const nextItems = [];
  d.orig.forEach((o, id) => {
    const c = cardById(id);
    if (c.start !== o.start || c.end !== o.end || laneOf(c) !== o.lane) {
      prevItems.push({ id, start: o.start, end: o.end, lane: o.lane });
      nextItems.push({ id, start: c.start, end: c.end, lane: laneOf(c) });
      changed.push(c);
    }
  });
  if (!changed.length) return;
  pushUndo({
    undo: () => applyItemSnapshots(prevItems),
    redo: () => applyItemSnapshots(nextItems),
  });
  markDirty();
  afterTimingChange(changed);
});

// -- zoom / lanes --

function setZoom(pps) {
  state.pps = clamp(pps, 15, 600);
  renderTimeline();
}
$("#tlZoomIn").addEventListener("click", () => setZoom(state.pps * 1.35));
$("#tlZoomOut").addEventListener("click", () => setZoom(state.pps / 1.35));
$("#tlScroll").addEventListener("wheel", (e) => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  setZoom(state.pps * (e.deltaY < 0 ? 1.2 : 1 / 1.2));
}, { passive: false });

$("#addLaneBtn").addEventListener("click", () => {
  state.laneCount += 1;
  state.activeLane = state.laneCount - 1;
  pushUndo({
    undo: () => {
      state.laneCount = Math.max(1, state.laneCount - 1);
      state.activeLane = Math.min(state.activeLane, state.laneCount - 1);
      renderWords(); renderTimeline();
    },
    redo: () => {
      state.laneCount += 1;
      state.activeLane = state.laneCount - 1;
      renderWords(); renderTimeline();
    },
  });
  renderWords();
  renderTimeline();
});

function removeLastLane() {
  if (state.laneCount <= 1) return;
  const lane = state.laneCount - 1;
  const inLane = state.cards.filter((c) => laneOf(c) === lane);
  if (inLane.length && !confirm(
    `Timeline ${lane + 1} has ${inLane.length} caption${inLane.length > 1 ? "s" : ""}. ` +
    `Move ${inLane.length > 1 ? "them" : "it"} to Timeline ${lane} and remove this timeline?`)) return;
  const items = inLane.map((c) => ({ id: c._id, lane }));
  inLane.forEach((c) => { if (lane - 1) c.lane = lane - 1; else delete c.lane; });
  state.laneCount -= 1;
  state.activeLane = Math.min(state.activeLane, state.laneCount - 1);
  pushUndo({
    undo: () => {
      state.laneCount += 1;
      items.forEach((it) => { const c = cardById(it.id); if (c) { if (it.lane) c.lane = it.lane; else delete c.lane; } });
      sortCards(); renderWords(); renderTimeline();
    },
    redo: () => {
      items.forEach((it) => { const c = cardById(it.id); if (c) { if (lane - 1) c.lane = lane - 1; else delete c.lane; } });
      state.laneCount = lane;
      state.activeLane = Math.min(state.activeLane, state.laneCount - 1);
      sortCards(); renderWords(); renderTimeline();
    },
  });
  if (inLane.length) markDirty();
  sortCards();
  renderWords();
  renderTimeline();
}

// ---------- undo / redo ----------
// Every mutating action pushes {undo(), redo(), ...} — both closures replay
// exactly what the original edit did, so there's one code path per action
// instead of separate forward/reverse interpreters. History is capped at
// MAX_HISTORY steps each way; making any new edit clears the redo branch,
// same as every other undo/redo implementation.

function pushUndo(action) {
  state.undoStack.push(action);
  if (state.undoStack.length > MAX_HISTORY) state.undoStack.shift();
  state.redoStack = [];
  updateHistoryButtons();
}

function undoLast() {
  const a = state.undoStack.pop();
  if (!a) return;
  a.undo();
  state.redoStack.push(a);
  if (state.redoStack.length > MAX_HISTORY) state.redoStack.shift();
  markDirty(state.undoStack.length > 0 || state.dirty);
  updateHistoryButtons();
}

function redoLast() {
  const a = state.redoStack.pop();
  if (!a) return;
  a.redo();
  state.undoStack.push(a);
  if (state.undoStack.length > MAX_HISTORY) state.undoStack.shift();
  markDirty(true);
  updateHistoryButtons();
}

function updateHistoryButtons() {
  const undoBtn = $("#undoBtn");
  const redoBtn = $("#redoBtn");
  if (undoBtn) undoBtn.disabled = state.undoStack.length === 0;
  if (redoBtn) redoBtn.disabled = state.redoStack.length === 0;
}

$("#undoBtn").addEventListener("click", undoLast);
$("#redoBtn").addEventListener("click", redoLast);
updateHistoryButtons();

// ---------- current-word lookup & tagging ----------

const REACTION_LEEWAY = 0.35; // seconds of tolerance for a slightly-late keypress

// The caption a "tag the current word" keypress means: the most recently
// started one (any timeline). Ties go to the lowest timeline.
function currentCardIndex(t) {
  let best = -1;
  for (let i = 0; i < state.cards.length; i++) {
    const c = state.cards[i];
    if (c.start > t + REACTION_LEEWAY) break;
    if (best < 0 || c.start > state.cards[best].start) best = i;
  }
  return best;
}

function currentCardInLane(t, lane) {
  let best = null;
  for (const c of state.cards) {
    if (c.start > t + REACTION_LEEWAY) break;
    if (laneOf(c) === lane) best = c;
  }
  return best;
}

function assignSpeaker(name) {
  if (state.selection.size > 0) {
    const items = [];
    for (const id of state.selection) {
      const card = cardById(id);
      if (!card || card.speaker === name) continue;
      items.push({ id, prev: card.speaker });
      card.speaker = name;
    }
    if (items.length > 0) {
      pushUndo({
        undo: () => items.forEach((it) => { const c = cardById(it.id); if (c) { c.speaker = it.prev; refreshRow(c); } }),
        redo: () => items.forEach((it) => { const c = cardById(it.id); if (c) { c.speaker = name; refreshRow(c); } }),
      });
      markDirty();
      items.forEach((item) => refreshRow(cardById(item.id)));
    }
    // Tagging always closes out the selection — next hotkey starts fresh
    // instead of silently piling onto whatever was selected before.
    clearSelection();
    return;
  }

  const idx = currentCardIndex(video().currentTime);
  if (idx < 0) return;
  const card = state.cards[idx];
  if (card.speaker === name) return;
  const prev = card.speaker;
  const id = card._id;
  card.speaker = name;
  pushUndo({
    undo: () => { const c = cardById(id); if (c) { c.speaker = prev; refreshRow(c); } },
    redo: () => { const c = cardById(id); if (c) { c.speaker = name; refreshRow(c); } },
  });
  markDirty();
  refreshRow(card);
  if (state.followVideo) {
    const row = rowOf(card._id);
    if (row) row.scrollIntoView({ block: "nearest" });
  }
}

// ---------- playback ----------

function isTypingTarget(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

document.addEventListener("keydown", (e) => {
  if ($("#editor").classList.contains("hidden")) return;
  if (isTypingTarget(document.activeElement)) return;
  if (!$("#speakerModal").classList.contains("hidden")) return;

  const v = video();
  if (e.key === " ") {
    e.preventDefault();
    v.paused ? v.play() : v.pause();
    return;
  }
  if (e.key === "<" || e.key === ",") {
    e.preventDefault();
    v.currentTime = Math.max(0, v.currentTime - 5);
    return;
  }
  if (e.key === ">" || e.key === ".") {
    e.preventDefault();
    v.currentTime = Math.min(v.duration || Infinity, v.currentTime + 5);
    return;
  }
  if (e.key === "Enter") {
    e.preventDefault();
    v.currentTime = 0;
    return;
  }
  if (e.key === "Backspace") {
    e.preventDefault();
    if (e.shiftKey) redoLast(); else undoLast();
    return;
  }
  if (e.key === "Escape") {
    e.preventDefault();
    clearSelection();
    return;
  }
  // Arrow keys bump the selected captions: ←/→ one frame (Shift = 10 frames),
  // ↑/↓ one timeline up/down.
  if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
    if (state.selection.size) {
      e.preventDefault();
      const frames = e.shiftKey ? 10 : 1;
      nudgeSelection((e.key === "ArrowLeft" ? -frames : frames) / FPS, 0);
    }
    return;
  }
  if (e.key === "ArrowUp" || e.key === "ArrowDown") {
    if (state.selection.size) {
      e.preventDefault();
      nudgeSelection(0, e.key === "ArrowUp" ? -1 : 1);
    }
    return;
  }
  const key = e.key.toLowerCase();
  const sp = state.speakers.find((s) => s.key === key);
  if (sp) {
    e.preventDefault();
    assignSpeaker(sp.name);
  }
});

// The live preview mirrors the renderer: timeline 1 is the big main caption,
// further timelines stack smaller underneath it.
function renderOverlayLanes() {
  const overlay = $("#overlay");
  overlay.innerHTML = "";
  for (let i = 0; i < state.laneCount; i++) {
    const d = document.createElement("div");
    d.className = "ov-line" + (i > 0 ? " ov-sub" : "");
    d.dataset.lane = i;
    overlay.appendChild(d);
  }
}

function updateOverlay() {
  const t = video().currentTime;
  document.querySelectorAll("#overlay .ov-line").forEach((d) => {
    const lane = parseInt(d.dataset.lane, 10);
    const card = currentCardInLane(t, lane);
    if (!card || t > card.end + 0.4) { d.textContent = ""; return; }
    d.textContent = card.lines.join("\n").toUpperCase();
    const sp = card.speaker ? speakerByName(card.speaker) : null;
    d.style.color = sp ? sp.color : "#ffffff";
  });

  const idx = currentCardIndex(t);
  document.querySelectorAll(".word-row.current").forEach((r) => r.classList.remove("current"));
  if (idx < 0 || t > state.cards[idx].end + 0.4) return;
  const row = rowOf(state.cards[idx]._id);
  if (row) {
    row.classList.add("current");
    // Still marked so you can find the live word by eye while browsing,
    // just doesn't yank the list to it unless following is turned on.
    if (state.followVideo) row.scrollIntoView({ block: "center", behavior: "smooth" });
  }
}

function followTimeline() {
  if (!state.followVideo || tlDrag || scrubbing) return;
  const scroll = tlScroll();
  const x = video().currentTime * state.pps;
  const view = scroll.clientWidth - LABEL_W;
  if (x < scroll.scrollLeft + 10 || x > scroll.scrollLeft + view - 40) {
    scroll.scrollLeft = Math.max(0, x - view * 0.25);
  }
}

function tick() {
  const v = video();
  if (v.duration) {
    updateOverlay();
    placePlayhead();
    followTimeline();
    if (!state.dragging) {
      $("#seekBar").value = Math.round((v.currentTime / v.duration) * 1000);
    }
    $("#timeLabel").textContent = `${fmtTime(v.currentTime)} / ${fmtTime(v.duration)}`;
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

$("#seekBar").addEventListener("input", () => {
  state.dragging = true;
  const v = video();
  if (v.duration) v.currentTime = (parseInt($("#seekBar").value, 10) / 1000) * v.duration;
});
$("#seekBar").addEventListener("change", () => { state.dragging = false; });

// ---------- save ----------

$("#saveBtn").addEventListener("click", async () => {
  const strayStar = state.cards.filter((c) => c.lines.some((l) => l.includes("*"))).length;
  if (strayStar > 0) {
    const proceed = confirm(
      `${strayStar} caption${strayStar > 1 ? "s contain" : " contains"} a lone * that isn't closed — ` +
      `it would show up in the video. Close it as *note* or remove it. Save anyway?`
    );
    if (!proceed) return;
  }
  const emptyCount = state.cards.filter((c) => !c.lines.join("").trim()).length;
  if (emptyCount > 0) {
    const proceed = confirm(
      `${emptyCount} caption${emptyCount > 1 ? "s have" : " has"} no text — an empty caption ` +
      `will break the render. Save anyway? (Cancel to go back and fill it in or delete it.)`
    );
    if (!proceed) return;
  }
  if (!state.speakersHandle) {
    try {
      state.speakersHandle = await window.showSaveFilePicker({
        suggestedName: state.cardsHandle.name.replace(/\.json$/i, "") + "_speakers.json",
        types: JSON_TYPES,
      });
    } catch (e) {
      if (e.name === "AbortError") return; // user cancelled, don't lose their edits
      alert("Couldn't create speakers.json: " + e.message);
      return;
    }
  }
  if (!(await ensureReadWrite(state.speakersHandle))) {
    alert("Write permission for speakers.json was denied.");
    return;
  }

  sortCards();
  const bakedCards = state.cards.map((c) => {
    // Carry through any field the editor doesn't manage (fx, emphasis_scale,
    // ...) so saving never silently strips data another tool put on a card.
    const { _id, speaker: _s, fill: _f, note: _n, lane: _l, ...passthrough } = c;
    const out = { ...passthrough, start: c.start, end: c.end, lines: c.lines };
    if (laneOf(c)) out.lane = laneOf(c);
    if (c.note) out.note = c.note;
    if (c.speaker) {
      out.speaker = c.speaker;
      const sp = speakerByName(c.speaker);
      if (sp) out.fill = hexToRgba(sp.color);
      else if (c.fill) out.fill = c.fill;
    } else if (c.fill) {
      out.fill = c.fill; // leave untouched if never retagged
    }
    return out;
  });

  try {
    const cardsWritable = await state.cardsHandle.createWritable();
    await cardsWritable.write(JSON.stringify(bakedCards, null, 2));
    await cardsWritable.close();

    const spWritable = await state.speakersHandle.createWritable();
    await spWritable.write(JSON.stringify(state.speakers, null, 2));
    await spWritable.close();
  } catch (e) {
    alert("Save failed: " + e.message);
    return;
  }

  markDirty(false);
  $("#speakersPathLabel").textContent = state.speakersHandle.name;
  $("#speakersPathLabel").classList.add("chosen");
  const btn = $("#saveBtn");
  const original = btn.textContent;
  btn.textContent = "Saved ✓";
  setTimeout(() => { btn.textContent = original; }, 1200);
});

window.addEventListener("beforeunload", (e) => {
  if (state.dirty) { e.preventDefault(); e.returnValue = ""; }
});
