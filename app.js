"use strict";

const state = {
  videoHandle: null,
  cardsHandle: null,
  speakersHandle: null, // may be null until first save, then remembered
  videoObjectUrl: null,
  cards: [],       // [{start, end, lines:[text], speaker: name|null, fill?: [r,g,b,a]}]
  speakers: [],    // [{name, key, color}]  color = "#rrggbb"
  undoStack: [],
  dirty: false,
  editingSpeakerIdx: null, // index into state.speakers, or null for "adding new"
  dragging: false,
  selection: new Set(), // selected card indices
  lastSelectedIdx: null,
  followVideo: true, // when true, the caption list auto-scrolls to track the current word
};

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
    const card = { ...c, lines: [...c.lines], speaker: c.speaker || null };
    const before = JSON.stringify([card.lines, card.note || null]);
    applyEditorText(card, cardEditorText(card));
    if (JSON.stringify([card.lines, card.note || null]) !== before) migrated = true;
    return card;
  });
  state.speakers = speakers;
  state.undoStack = [];
  state.selection = new Set();
  state.lastSelectedIdx = null;
  markDirty(migrated);

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
  renderSelectionStatus();
}

$("#backToSetupBtn").addEventListener("click", () => {
  if (state.dirty && !confirm("You have unsaved changes. Discard and load different files?")) return;
  $("#editor").classList.add("hidden");
  $("#setup").classList.remove("hidden");
});

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
    state.speakers.push({ name, key, color });
  } else {
    const oldName = state.speakers[state.editingSpeakerIdx].name;
    state.speakers[state.editingSpeakerIdx] = { name, key, color };
    if (oldName !== name) {
      state.cards.forEach((c) => { if (c.speaker === oldName) c.speaker = name; });
    }
  }
  markDirty();
  renderSpeakers();
  renderWords();
  closeSpeakerModal();
});

$("#spDelete").addEventListener("click", () => {
  if (state.editingSpeakerIdx === null) return;
  const sp = state.speakers[state.editingSpeakerIdx];
  if (!confirm(`Delete speaker "${sp.name}"? Words already tagged with them will show as unassigned.`)) return;
  state.speakers.splice(state.editingSpeakerIdx, 1);
  markDirty();
  renderSpeakers();
  renderWords();
  closeSpeakerModal();
});

// ---------- follow-video toggle ----------

$("#followToggle").addEventListener("click", () => {
  state.followVideo = !state.followVideo;
  const btn = $("#followToggle");
  btn.textContent = state.followVideo ? "🔒 Following video" : "🔓 Free scroll";
  btn.classList.toggle("unlocked", !state.followVideo);
});

// ---------- words panel & selection ----------

function renderWords() {
  const list = $("#wordsList");
  list.innerHTML = "";
  state.cards.forEach((card, idx) => {
    const row = document.createElement("div");
    row.className = "word-row" + (state.selection.has(idx) ? " selected" : "");
    row.dataset.idx = idx;

    const handle = document.createElement("span");
    handle.className = "row-handle";
    handle.textContent = "☰";
    handle.title = "Click to select — drag for a range, Shift-click to extend, Ctrl-click to add/remove one";
    handle.addEventListener("mousedown", (e) => onHandleMouseDown(e, idx));
    handle.addEventListener("mouseenter", () => onHandleMouseEnter(idx));

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
      if (isNaN(next) || next >= card.end) {
        startInput.value = card.start.toFixed(3);
        return;
      }
      const prev = card.start;
      card.start = next;
      pushUndo({ type: "timing", idx, field: "start", prev, next });
      markDirty();
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
      if (isNaN(next) || next <= card.start) {
        endInput.value = card.end.toFixed(3);
        return;
      }
      const prev = card.end;
      card.end = next;
      pushUndo({ type: "timing", idx, field: "end", prev, next });
      markDirty();
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
      pushUndo({ type: "text", idx, prev, next: text.value });
      updateNoteChip(text.closest(".word-row"), card);
      markDirty();
    });

    const noteChip = document.createElement("span");
    noteChip.className = "note-chip hidden";

    const badge = document.createElement("span");
    badge.className = "speaker-badge" + (card.speaker ? "" : " unassigned");
    badge.textContent = card.speaker || "—";
    const sp = card.speaker ? speakerByName(card.speaker) : null;
    if (sp) { badge.style.background = sp.color; badge.style.color = "#101215"; }

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
    insertBtn.addEventListener("click", (e) => { e.stopPropagation(); insertCardAfter(idx); });

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "row-icon-btn danger";
    deleteBtn.textContent = "✕";
    deleteBtn.title = "Delete this caption";
    deleteBtn.addEventListener("click", (e) => { e.stopPropagation(); deleteCard(idx); });

    row.appendChild(handle);
    row.appendChild(seekBtn);
    row.appendChild(startInput);
    row.appendChild(sep);
    row.appendChild(endInput);
    row.appendChild(text);
    row.appendChild(noteChip);
    row.appendChild(badge);
    row.appendChild(emojiBtn);
    row.appendChild(insertBtn);
    row.appendChild(deleteBtn);
    list.appendChild(row);
    updateNoteChip(row, card);
  });
}

function updateNoteChip(row, card) {
  if (!row) return;
  const chip = row.querySelector(".note-chip");
  chip.classList.toggle("hidden", !card.note);
  chip.textContent = card.note ? "📝 note" : "";
  chip.title = card.note || "";
}

// ---------- insert / delete captions ----------

function insertCardAt(idx, start, end) {
  state.cards.splice(idx, 0, { start, end, lines: [""], speaker: null });
  pushUndo({ type: "insert", idx });
  markDirty();
  clearSelection();
  renderWords();
  const row = $(`.word-row[data-idx="${idx}"]`);
  if (row) {
    row.scrollIntoView({ block: "center" });
    row.querySelector(".text").focus();
  }
}

function insertCardAfter(idx) {
  const card = state.cards[idx];
  const next = state.cards[idx + 1];
  const start = card.end;
  let end = start + 0.3;
  if (next) end = Math.min(end, next.start);
  end = Math.max(end, start + 0.05);
  insertCardAt(idx + 1, start, end);
}

function insertCardAtTime(t) {
  let idx = state.cards.findIndex((c) => c.start > t);
  if (idx === -1) idx = state.cards.length;
  const next = state.cards[idx];
  let end = t + 0.3;
  if (next) end = Math.min(end, next.start);
  end = Math.max(end, t + 0.05);
  insertCardAt(idx, t, end);
}

function deleteCard(idx) {
  const [removed] = state.cards.splice(idx, 1);
  pushUndo({ type: "delete", idx, card: removed });
  markDirty();
  clearSelection();
  renderWords();
}

$("#addCaptionBtn").addEventListener("click", () => insertCardAtTime(video().currentTime));

// ---------- emoji picker ----------

const EMOJI_SET = [
  "😀", "😂", "😭", "😱", "😡", "🤔", "😴", "😎", "🥵", "🥶", "😈", "👀",
  "💀", "🔥", "💯", "👍", "👎", "👏", "🙌", "🤝", "🙏", "💪", "🤡", "🎮",
  "🎉", "🎂", "🍻", "🍺", "💰", "🪓", "⚔️", "🛡️", "🏆", "⭐", "✨", "💥",
  "⚡", "❤️", "💚", "💛", "💙", "💜", "🖤", "🤍", "🚫", "❌", "✅", "❓",
  "❗", "😅", "🤯", "🫡",
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

// ---------- drag-to-select (via the row-handle grip only, never the text
// or timestamp, so a selection drag can't turn into a native text
// selection or collide with editing/seeking) ----------

let dragAnchorIdx = null;
let dragAdditive = false;
let dragBaseSelection = null;

function onHandleMouseDown(e, idx) {
  e.preventDefault(); // stop the drag from starting a native text selection
  if (e.shiftKey && state.lastSelectedIdx !== null) {
    dragAnchorIdx = state.lastSelectedIdx;
    dragAdditive = false;
    dragBaseSelection = null;
    applyDragRange(idx);
  } else if (e.ctrlKey || e.metaKey) {
    if (state.selection.has(idx)) state.selection.delete(idx);
    else state.selection.add(idx);
    state.lastSelectedIdx = idx;
    dragAnchorIdx = idx;
    dragAdditive = true;
    dragBaseSelection = new Set(state.selection);
    applySelectionClasses();
    renderSelectionStatus();
  } else {
    dragAnchorIdx = idx;
    dragAdditive = false;
    dragBaseSelection = null;
    state.selection = new Set([idx]);
    state.lastSelectedIdx = idx;
    applySelectionClasses();
    renderSelectionStatus();
  }
}

function onHandleMouseEnter(idx) {
  if (dragAnchorIdx === null) return; // not mid-drag
  applyDragRange(idx);
}

function applyDragRange(idx) {
  const [lo, hi] = dragAnchorIdx <= idx ? [dragAnchorIdx, idx] : [idx, dragAnchorIdx];
  state.selection = dragAdditive ? new Set(dragBaseSelection) : new Set();
  for (let i = lo; i <= hi; i++) state.selection.add(i);
  state.lastSelectedIdx = idx;
  applySelectionClasses();
  renderSelectionStatus();
}

document.addEventListener("mouseup", () => {
  dragAnchorIdx = null;
  dragBaseSelection = null;
});

function applySelectionClasses() {
  document.querySelectorAll(".word-row").forEach((row) => {
    const idx = parseInt(row.dataset.idx, 10);
    row.classList.toggle("selected", state.selection.has(idx));
  });
}

function renderSelectionStatus() {
  const el = $("#selectionStatus");
  if (state.selection.size > 1) {
    el.textContent = `${state.selection.size} words selected — press a speaker key to tag all of them, or Esc to clear`;
    el.classList.remove("hidden");
  } else {
    el.classList.add("hidden");
  }
}

function clearSelection() {
  state.selection = new Set();
  state.lastSelectedIdx = null;
  applySelectionClasses();
  renderSelectionStatus();
}

function refreshRow(idx) {
  const row = $(`.word-row[data-idx="${idx}"]`);
  if (!row) return;
  const card = state.cards[idx];
  row.querySelector(".text").value = cardEditorText(card);
  updateNoteChip(row, card);
  row.querySelector(".start-time").value = card.start.toFixed(3);
  row.querySelector(".end-time").value = card.end.toFixed(3);
  const badge = row.querySelector(".speaker-badge");
  badge.textContent = card.speaker || "—";
  badge.className = "speaker-badge" + (card.speaker ? "" : " unassigned");
  const sp = card.speaker ? speakerByName(card.speaker) : null;
  if (sp) { badge.style.background = sp.color; badge.style.color = "#101215"; }
  else { badge.style.background = ""; badge.style.color = ""; }
  row.classList.add("flash");
  setTimeout(() => row.classList.remove("flash"), 500);
}

// ---------- undo ----------

function pushUndo(action) {
  state.undoStack.push(action);
}

function undoLast() {
  const action = state.undoStack.pop();
  if (!action) return;
  if (action.type === "speaker") {
    state.cards[action.idx].speaker = action.prev;
    refreshRow(action.idx);
  } else if (action.type === "text") {
    applyEditorText(state.cards[action.idx], action.prev);
    refreshRow(action.idx);
  } else if (action.type === "speaker-batch") {
    for (const item of action.items) {
      state.cards[item.idx].speaker = item.prev;
      refreshRow(item.idx);
    }
  } else if (action.type === "timing") {
    state.cards[action.idx][action.field] = action.prev;
    refreshRow(action.idx);
  } else if (action.type === "insert") {
    state.cards.splice(action.idx, 1);
    clearSelection();
    renderWords();
  } else if (action.type === "delete") {
    state.cards.splice(action.idx, 0, action.card);
    clearSelection();
    renderWords();
  }
  markDirty(state.undoStack.length > 0 || state.dirty);
}

// ---------- current-word lookup & tagging ----------

const REACTION_LEEWAY = 0.35; // seconds of tolerance for a slightly-late keypress

function currentCardIndex(t) {
  let best = -1;
  for (let i = 0; i < state.cards.length; i++) {
    if (state.cards[i].start <= t + REACTION_LEEWAY) best = i;
    else break;
  }
  return best;
}

function assignSpeaker(name) {
  if (state.selection.size > 0) {
    const items = [];
    for (const idx of state.selection) {
      const card = state.cards[idx];
      if (card.speaker === name) continue;
      items.push({ idx, prev: card.speaker });
      card.speaker = name;
    }
    if (items.length > 0) {
      pushUndo({ type: "speaker-batch", items, next: name });
      markDirty();
      items.forEach((item) => refreshRow(item.idx));
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
  card.speaker = name;
  pushUndo({ type: "speaker", idx, prev, next: name });
  markDirty();
  refreshRow(idx);
  if (state.followVideo) {
    const row = $(`.word-row[data-idx="${idx}"]`);
    if (row) row.scrollIntoView({ block: "nearest" });
  }
}

// ---------- playback ----------

function isTypingTarget(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || el.isContentEditable;
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
    undoLast();
    return;
  }
  if (e.key === "Escape") {
    e.preventDefault();
    clearSelection();
    return;
  }
  const key = e.key.toLowerCase();
  const sp = state.speakers.find((s) => s.key === key);
  if (sp) {
    e.preventDefault();
    assignSpeaker(sp.name);
  }
});

function updateOverlay() {
  const idx = currentCardIndex(video().currentTime);
  const overlay = $("#overlay");
  if (idx < 0 || !state.cards[idx] || video().currentTime > state.cards[idx].end + 0.4) {
    overlay.textContent = "";
    return;
  }
  const card = state.cards[idx];
  overlay.textContent = card.lines.join("\n").toUpperCase();
  const sp = card.speaker ? speakerByName(card.speaker) : null;
  overlay.style.color = sp ? sp.color : "#ffffff";

  document.querySelectorAll(".word-row.current").forEach((r) => r.classList.remove("current"));
  const row = $(`.word-row[data-idx="${idx}"]`);
  if (row) {
    row.classList.add("current");
    // Still marked so you can find the live word by eye while browsing,
    // just doesn't yank the list to it unless following is turned on.
    if (state.followVideo) row.scrollIntoView({ block: "center", behavior: "smooth" });
  }
}

function tick() {
  const v = video();
  if (v.duration) {
    updateOverlay();
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

  const bakedCards = state.cards.map((c) => {
    // Carry through any field the editor doesn't manage (fx, emphasis_scale,
    // ...) so saving never silently strips data another tool put on a card.
    const { speaker: _s, fill: _f, note: _n, ...passthrough } = c;
    const out = { ...passthrough, start: c.start, end: c.end, lines: c.lines };
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
