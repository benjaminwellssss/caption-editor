"use strict";

const FPS = 30;              // frame step for snapping and arrow-key bumps
const LABEL_W = 120;         // width of the lane-label column in the timeline (matches style.css)
const MAX_HISTORY = 10;      // how many undo/redo steps are kept
const PPS_MIN = 15, PPS_MAX = 600; // timeline zoom range, pixels per second

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
  // Timelines, top to bottom. A speaker's captions live on that speaker's timeline; a speaker who hasn't
  // been tagged yet has no timeline ("hidden") until the first tag creates one. Saved card.lane is the index.
  lanes: [{ name: "Main", speaker: null }],
  font: "Bebas Neue", // saved into the speakers sidecar as {font, font_file?, speakers, lanes}
  fontFile: null,     // full path when the font was picked from the installed-font list
  favoriteFonts: [],  // [{family, file}] - app-wide, kept in the server's settings.json
  undoStack: [],   // each entry: {undo(), redo(), ...bookkeeping} — capped at MAX_HISTORY
  redoStack: [],
  dirty: false,
  editingSpeakerIdx: null, // index into state.speakers, or null for "adding new"
  dragging: false,         // seek bar being dragged
  selection: new Set(),    // selected card _ids
  lastSelectedId: null,
  followVideo: true,       // list + timeline follow the playhead until you scroll them by hand
  activeLane: 0,           // where "+ Add caption" puts a new caption
  pps: 80,                 // timeline zoom, pixels per second
  peaks: null,             // audio waveform: Float32Array of peak levels, PEAK_RATE per second
};
let nextId = 1;
const PEAK_RATE = 200;

const $ = (sel) => document.querySelector(sel);
const video = () => $("#video");
const laneCount = () => state.lanes.length;

// Starting roster for a brand-new project when no speakers config was picked and none is remembered
// from last time (settings.json) - fully editable afterward.
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

// Fonts the renderer (render_captions.py's FONTS) knows by name alone. Any other font is saved with its
// file path (font_file) so the renderer can load it directly.
const FONTS = ["Bebas Neue", "Montserrat Black", "Anton", "Archivo Black", "Poppins ExtraBold"];
const DEFAULT_FONT = "Bebas Neue";

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
  return [parseInt(h.substring(0, 2), 16), parseInt(h.substring(2, 4), 16), parseInt(h.substring(4, 6), 16), 255];
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function speakerByName(name) {
  return state.speakers.find((s) => s.name === name);
}

const laneOf = (card) => card.lane || 0;
const setLane = (card, lane) => { if (lane) card.lane = lane; else delete card.lane; };
const cardById = (id) => state.cards.find((c) => c._id === id);
const idxById = (id) => state.cards.findIndex((c) => c._id === id);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function sortCards() {
  state.cards.sort((a, b) => a.start - b.start || laneOf(a) - laneOf(b));
}

const orderKey = () => state.cards.map((c) => c._id).join(",");

// ---------- app-wide settings (speaker roster, favourite fonts) ----------
// Kept by server.py in settings.json, so they survive closing the editor. Saved on every change and once
// more on exit.

let settings = {};
let settingsTimer = null;

async function loadSettings() {
  try { settings = await (await fetch("/settings")).json(); } catch { settings = {}; }
  state.favoriteFonts = Array.isArray(settings.favoriteFonts) ? settings.favoriteFonts : [];
}

function settingsPayload() {
  return JSON.stringify({ speakers: state.speakers, favoriteFonts: state.favoriteFonts });
}

function saveSettingsSoon() {
  clearTimeout(settingsTimer);
  settingsTimer = setTimeout(() => {
    fetch("/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: settingsPayload() })
      .catch(() => {});
  }, 400);
}

window.addEventListener("pagehide", () => {
  if (state.speakers.length) navigator.sendBeacon("/settings", new Blob([settingsPayload()], { type: "application/json" }));
});

loadSettings();

// ---------- editor text syntax ----------
// The caption text box holds only what's displayed on screen:
//   |  -> a line break: "HECK|YES" shows HECK above YES.
// Production notes live in their own field (card.note). A stray *note* typed into the caption box (legacy
// files) is still pulled out into card.note as a migration safety net.

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

const cardEditorText = (card) => card.lines.join("|");
const cardNotesText = (card) => card.note || "";

function applyEditorText(card, raw) {
  const parsed = parseEditorText(raw);
  card.lines = parsed.lines;
  if (parsed.note) card.note = parsed.note;
}

function applyNotesText(card, raw) {
  const note = raw.replace(/\s+/g, " ").trim();
  if (note) card.note = note;
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
  if (!HAS_FSA) {
    alert("Opening files needs Chrome or Edge.");
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

// ---------- timelines (lanes) model ----------

// A layout snapshot - every card's speaker and timeline plus the timeline list - so any structural change
// (tagging, showing/hiding timelines) undoes as one step.
function snapshotLayout() {
  return {
    lanes: state.lanes.map((l) => ({ ...l })),
    cards: new Map(state.cards.map((c) => [c._id, { speaker: c.speaker, lane: laneOf(c) }])),
  };
}

function restoreLayout(snap) {
  state.lanes = snap.lanes.map((l) => ({ ...l }));
  state.cards.forEach((c) => {
    const s = snap.cards.get(c._id);
    if (s) { c.speaker = s.speaker; setLane(c, s.lane); }
  });
  state.activeLane = Math.min(state.activeLane, laneCount() - 1);
  sortCards();
  renderSpeakers(); renderWords(); renderTimeline();
}

function pushLayoutUndo(before) {
  const after = snapshotLayout();
  pushUndo({ undo: () => restoreLayout(before), redo: () => restoreLayout(after) });
}

// Lanes from a fresh caption file: one timeline per speaker, in speaker-roster order (so the first speaker
// in the roster - the streamer - is the top, big-caption timeline), untagged captions on the top timeline.
function organizeBySpeaker() {
  const present = new Set(state.cards.map((c) => c.speaker).filter(Boolean));
  const rank = (n) => { const i = state.speakers.findIndex((s) => s.name === n); return i < 0 ? 1e6 : i; };
  const order = [...present].sort((a, b) => rank(a) - rank(b));
  state.lanes = order.length ? order.map((n) => ({ name: n, speaker: n })) : [{ name: "Main", speaker: null }];
  state.cards.forEach((c) => setLane(c, c.speaker ? order.indexOf(c.speaker) : 0));
}

// The timeline a speaker's captions go on - created ("unhidden") the first time they're tagged. An
// unclaimed top timeline (no speaker yet) is taken over by the first speaker tagged.
function laneForSpeaker(name) {
  let i = state.lanes.findIndex((l) => l.speaker === name);
  if (i >= 0) return i;
  if (state.lanes[0].speaker === null && !state.cards.some((c) => c.speaker && laneOf(c) === 0 && c.speaker !== name)) {
    state.lanes[0] = { name, speaker: name };
    return 0;
  }
  state.lanes.push({ name, speaker: name });
  return state.lanes.length - 1;
}

function laneColor(lane) {
  const sp = lane && lane.speaker ? speakerByName(lane.speaker) : null;
  return sp ? sp.color : "#59625d";
}

// ---------- load project ----------

$("#loadBtn").addEventListener("click", loadProject);

async function loadProject() {
  const errEl = $("#setupError");
  errEl.textContent = "";

  if (!state.videoHandle || !state.cardsHandle) {
    errEl.textContent = "Choose both a video and a captions (cards.json) file.";
    return;
  }

  let cards;
  try {
    cards = JSON.parse(await (await state.cardsHandle.getFile()).text());
  } catch (e) {
    errEl.textContent = "Could not read cards.json: " + e.message;
    return;
  }

  let speakers = [];
  let font = DEFAULT_FONT;
  let fontFile = null;
  let savedLanes = null;
  if (state.speakersHandle) {
    try {
      const parsed = JSON.parse(await (await state.speakersHandle.getFile()).text());
      // Old files are a plain speakers array; newer ones are {font, font_file?, speakers, lanes?}.
      if (Array.isArray(parsed)) {
        speakers = parsed;
      } else {
        speakers = parsed.speakers || [];
        if (parsed.font) font = parsed.font;
        if (parsed.font_file) fontFile = parsed.font_file;
        if (Array.isArray(parsed.lanes) && parsed.lanes.length) savedLanes = parsed.lanes;
      }
    } catch (e) {
      errEl.textContent = "Could not read speakers.json: " + e.message;
      return;
    }
  }
  if (speakers.length === 0) {
    speakers = (Array.isArray(settings.speakers) && settings.speakers.length ? settings.speakers : DEFAULT_SPEAKERS)
      .map((s) => ({ ...s }));
  }

  if (!(await ensureReadWrite(state.cardsHandle))) {
    errEl.textContent = "Write permission for cards.json was denied, so changes couldn't be saved.";
    return;
  }

  let migrated = false;
  state.cards = cards.map((c) => {
    const card = { ...c, _id: nextId++, lines: [...c.lines], speaker: c.speaker || null };
    if (card.lane) card.lane = Math.max(0, Math.floor(card.lane)); else delete card.lane;
    const before = JSON.stringify([card.lines, card.note || null]);
    applyEditorText(card, cardEditorText(card));
    if (JSON.stringify([card.lines, card.note || null]) !== before) migrated = true;
    return card;
  });
  state.speakers = speakers;

  const maxLane = Math.max(0, ...state.cards.map(laneOf));
  if (savedLanes) {
    state.lanes = savedLanes.map((l, i) => (typeof l === "string" ? { name: l, speaker: null } : { name: l.name || `Timeline ${i + 1}`, speaker: l.speaker || null }));
  } else if (maxLane === 0) {
    organizeBySpeaker(); // first open of a fresh caption file: put each speaker on their own timeline
    if (state.cards.some((c) => laneOf(c) > 0)) migrated = true;
  } else {
    state.lanes = [];
  }
  while (state.lanes.length <= maxLane) state.lanes.push({ name: `Timeline ${state.lanes.length + 1}`, speaker: null });

  sortCards();
  state.activeLane = 0;
  state.font = font;
  state.fontFile = fontFile;
  renderFontSelect();
  applyOverlayFont();
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
    `${videoFile.name} · ${state.cardsHandle.name} · ${state.speakersHandle ? state.speakersHandle.name : "speakers: made on save"}`;

  $("#setup").classList.add("hidden");
  $("#editor").classList.remove("hidden");

  renderSpeakers();
  renderWords();
  renderTimeline();
  renderSelectionStatus();
  setFollow(true);
  loadWaveform(videoFile);
}

$("#backToSetupBtn").addEventListener("click", () => {
  if (state.dirty && !confirm("You have unsaved changes. Discard them and open different files?")) return;
  $("#editor").classList.add("hidden");
  $("#setup").classList.remove("hidden");
});

video().addEventListener("loadedmetadata", () => renderTimeline());

// ---------- audio waveform ----------
// Decodes the video's own audio track in the browser and keeps one peak level per 1/PEAK_RATE s, so spikes
// (sibilance, plosives, laughs) line up with the captions on the same time scale.

async function loadWaveform(file) {
  state.peaks = null;
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const audio = await ctx.decodeAudioData(await file.arrayBuffer());
    ctx.close();
    const n = Math.ceil(audio.duration * PEAK_RATE);
    const peaks = new Float32Array(n);
    const per = audio.sampleRate / PEAK_RATE;
    for (let ch = 0; ch < audio.numberOfChannels; ch++) {
      const data = audio.getChannelData(ch);
      for (let i = 0; i < n; i++) {
        let m = 0;
        const a = Math.floor(i * per), b = Math.min(data.length, Math.floor((i + 1) * per));
        for (let j = a; j < b; j++) { const v = Math.abs(data[j]); if (v > m) m = v; }
        if (m > peaks[i]) peaks[i] = m;
      }
    }
    state.peaks = peaks;
    state.peaksMax = peaks.reduce((m, v) => Math.max(m, v), 0);
  } catch (e) {
    console.warn("waveform unavailable:", e);
  }
  drawWaveform();
}

function drawWaveform() {
  const canvas = $("#tlWave");
  if (!canvas) return;
  const scroll = tlScroll();
  const w = Math.max(1, scroll.clientWidth - LABEL_W);
  const h = 44;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  canvas.style.width = w + "px";
  canvas.style.left = scroll.scrollLeft + "px"; // the canvas only covers what's on screen
  const g = canvas.getContext("2d");
  g.scale(dpr, dpr);
  g.clearRect(0, 0, w, h);
  g.fillStyle = "#59625d";
  g.font = "10px Consolas, monospace";
  if (!state.peaks) { g.fillText(state.videoObjectUrl ? "reading audio…" : "", 8, 26); return; }
  g.fillStyle = "#39ff7a";
  const mid = h / 2;
  const top = state.peaksMax || 1;
  for (let x = 0; x < w; x++) {
    const t0 = (scroll.scrollLeft + x) / state.pps, t1 = (scroll.scrollLeft + x + 1) / state.pps;
    let m = 0;
    for (let i = Math.floor(t0 * PEAK_RATE); i <= Math.floor(t1 * PEAK_RATE) && i < state.peaks.length; i++) m = Math.max(m, state.peaks[i] || 0);
    const a = (m / top) * (mid - 2); // linear, scaled to the loudest peak, so spikes stand out from speech
    if (a > 0.3) g.fillRect(x, mid - a, 1, a * 2);
  }
}

// ---------- speakers panel ----------

function renderSpeakers() {
  const list = $("#speakersList");
  list.innerHTML = "";
  state.speakers.forEach((sp, idx) => {
    const chip = document.createElement("div");
    chip.className = "speaker-chip";
    chip.innerHTML = `<span class="swatch" style="background:${sp.color};color:${sp.color}"></span>
      <span class="key">${esc(sp.key.toUpperCase())}</span> ${esc(sp.name)}`;
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

function blurFocused() {
  // A display:none ancestor doesn't auto-blur a focused input in every browser - left focused,
  // isTypingTarget() would keep swallowing every hotkey.
  if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
}

function closeSpeakerModal() {
  $("#speakerModal").classList.add("hidden");
  blurFocused();
}

$("#speakerModalClose").addEventListener("click", closeSpeakerModal);
$("#spCancel").addEventListener("click", closeSpeakerModal);

function afterSpeakersChange() {
  markDirty();
  saveSettingsSoon();
  renderSpeakers(); renderWords(); renderTimeline();
}

$("#spSave").addEventListener("click", () => {
  const name = $("#spName").value.trim();
  const key = $("#spKey").value.trim().toLowerCase();
  const color = $("#spColor").value;
  const errEl = $("#speakerFormError");

  if (!name) { errEl.textContent = "Name is required."; return; }
  if (!key || key.length !== 1) { errEl.textContent = "Hotkey must be a single character."; return; }
  const RESERVED = [" ", "<", ">", ",", "."];
  if (RESERVED.includes(key)) { errEl.textContent = "That key is used for playback."; return; }

  const dupe = state.speakers.find((s, i) => s.key === key && i !== state.editingSpeakerIdx);
  if (dupe) { errEl.textContent = `"${key}" is already ${dupe.name}'s key.`; return; }
  const nameDupe = state.speakers.find((s, i) => s.name === name && i !== state.editingSpeakerIdx);
  if (nameDupe) { errEl.textContent = `There's already a speaker named "${name}".`; return; }

  const speakersBefore = state.speakers.map((s) => ({ ...s }));
  const layoutBefore = snapshotLayout();
  if (state.editingSpeakerIdx === null) {
    state.speakers.push({ name, key, color });
  } else {
    const oldName = state.speakers[state.editingSpeakerIdx].name;
    state.speakers[state.editingSpeakerIdx] = { name, key, color };
    if (oldName !== name) {
      state.cards.forEach((c) => { if (c.speaker === oldName) c.speaker = name; });
      state.lanes.forEach((l) => { if (l.speaker === oldName) { l.speaker = name; if (l.name === oldName) l.name = name; } });
    }
  }
  const speakersAfter = state.speakers.map((s) => ({ ...s }));
  const layoutAfter = snapshotLayout();
  pushUndo({
    undo: () => { state.speakers = speakersBefore.map((s) => ({ ...s })); restoreLayout(layoutBefore); saveSettingsSoon(); },
    redo: () => { state.speakers = speakersAfter.map((s) => ({ ...s })); restoreLayout(layoutAfter); saveSettingsSoon(); },
  });
  afterSpeakersChange();
  closeSpeakerModal();
});

$("#spDelete").addEventListener("click", () => {
  if (state.editingSpeakerIdx === null) return;
  const idx = state.editingSpeakerIdx;
  const sp = state.speakers[idx];
  if (!confirm(`Delete speaker "${sp.name}"? Captions already tagged with them will show as unassigned.`)) return;
  state.speakers.splice(idx, 1);
  pushUndo({
    undo: () => { state.speakers.splice(idx, 0, sp); saveSettingsSoon(); renderSpeakers(); renderWords(); renderTimeline(); },
    redo: () => { const i = state.speakers.indexOf(sp); if (i >= 0) state.speakers.splice(i, 1); saveSettingsSoon(); renderSpeakers(); renderWords(); renderTimeline(); },
  });
  afterSpeakersChange();
  closeSpeakerModal();
});

// ---------- fonts ----------

let fontIndex = null; // /fonts list, fetched the first time the picker opens

function renderFontSelect() {
  const sel = $("#fontSelect");
  const opts = FONTS.map((f) => ({ family: f, file: null }));
  state.favoriteFonts.forEach((f) => { if (!opts.some((o) => o.family === f.family)) opts.push(f); });
  if (!opts.some((o) => o.family === state.font)) opts.push({ family: state.font, file: state.fontFile });
  sel.innerHTML = opts.map((o) => `<option value="${esc(o.family)}" data-file="${esc(o.file || "")}">${esc(o.family)}${o.file && !FONTS.includes(o.family) ? " ★" : ""}</option>`).join("");
  sel.value = state.font;
}

function setFont(family, file) {
  if (state.font === family && state.fontFile === file) return;
  state.font = family;
  state.fontFile = FONTS.includes(family) ? null : (file || null);
  renderFontSelect();
  applyOverlayFont();
  markDirty(true);
}

$("#fontSelect").addEventListener("change", (e) => {
  const opt = e.target.selectedOptions[0];
  setFont(e.target.value, opt ? opt.dataset.file : null);
});

const loadedFaces = new Map();

async function previewFace(i) {
  if (!loadedFaces.has(i)) {
    const face = new FontFace(`cabpv${i}`, `url(/fontfile?i=${i})`);
    loadedFaces.set(i, face.load().then((f) => { document.fonts.add(f); return f; }).catch(() => null));
  }
  return loadedFaces.get(i);
}

async function applyOverlayFont() {
  const overlay = $("#overlay");
  overlay.style.fontFamily = `"${state.font}", Impact, "Arial Black", sans-serif`;
  if (!state.fontFile) return;
  const list = fontIndex || (fontIndex = await (await fetch("/fonts")).json().catch(() => []));
  const i = list.findIndex((f) => f.file === state.fontFile);
  if (i >= 0 && await previewFace(i)) overlay.style.fontFamily = `cabpv${i}, Impact, sans-serif`;
}

$("#fontPickerBtn").addEventListener("click", async () => {
  $("#fontModal").classList.remove("hidden");
  $("#fontSearch").focus();
  if (!fontIndex) {
    $("#fontList").innerHTML = `<p class="hint">Reading installed fonts…</p>`;
    fontIndex = await (await fetch("/fonts")).json().catch(() => []);
  }
  renderFontList();
});

$("#fontModalClose").addEventListener("click", () => { $("#fontModal").classList.add("hidden"); blurFocused(); });
$("#fontSearch").addEventListener("input", () => renderFontList());
$("#fontSample").addEventListener("input", () => {
  document.querySelectorAll(".font-item .fsample").forEach((el) => { el.textContent = $("#fontSample").value; });
});

const faceObserver = new IntersectionObserver((entries) => {
  entries.forEach((en) => {
    if (!en.isIntersecting) return;
    const i = +en.target.dataset.i;
    faceObserver.unobserve(en.target);
    previewFace(i).then((f) => { if (f) en.target.querySelector(".fsample").style.fontFamily = `cabpv${i}`; });
  });
}, { root: $("#fontList") });

function renderFontList() {
  const q = $("#fontSearch").value.trim().toLowerCase();
  const sample = esc($("#fontSample").value);
  const seen = new Set();
  const rows = [];
  (fontIndex || []).forEach((f, i) => {
    if (seen.has(f.family) || (q && !f.family.toLowerCase().includes(q))) return;
    seen.add(f.family); // one row per family, its Regular (or first) style
    rows.push({ ...f, i });
  });
  const shown = rows.slice(0, 250);
  const list = $("#fontList");
  list.innerHTML = shown.map((f) => {
    const fav = state.favoriteFonts.some((x) => x.family === f.family);
    return `<div class="font-item${f.family === state.font ? " current" : ""}" data-i="${f.i}">
      <span class="star${fav ? " on" : ""}" title="Show in the Font dropdown">${fav ? "★" : "☆"}</span>
      <span class="fname">${esc(f.family)}</span><span class="fsample">${sample}</span></div>`;
  }).join("") + (rows.length > shown.length ? `<p class="hint">${rows.length - shown.length} more: type to narrow down</p>` : "");
  list.querySelectorAll(".font-item").forEach((el) => {
    const f = fontIndex[+el.dataset.i];
    faceObserver.observe(el);
    el.querySelector(".star").addEventListener("click", (e) => {
      e.stopPropagation();
      const k = state.favoriteFonts.findIndex((x) => x.family === f.family);
      if (k >= 0) state.favoriteFonts.splice(k, 1); else state.favoriteFonts.push({ family: f.family, file: f.file });
      saveSettingsSoon();
      renderFontSelect();
      renderFontList();
    });
    el.addEventListener("click", () => { setFont(f.family, f.file); renderFontList(); });
  });
}

// ---------- help ----------

$("#helpBtn").addEventListener("click", () => $("#helpModal").classList.remove("hidden"));
$("#helpModalClose").addEventListener("click", () => $("#helpModal").classList.add("hidden"));
document.querySelectorAll(".modal").forEach((m) => m.addEventListener("mousedown", (e) => {
  if (e.target === m && m.id !== "speakerModal") { m.classList.add("hidden"); blurFocused(); }
}));

// ---------- follow / catch playhead ----------
// Following keeps the caption list and the timeline on the playhead. Scrolling either one by hand stops it;
// "Catch playhead" jumps back and resumes. Both panels scroll inside themselves, never the page.

let progScrollAt = 0; // when we last scrolled a panel ourselves, so our own scroll events don't cancel following

function setFollow(on) {
  state.followVideo = on;
  $("#catchBtn").classList.toggle("on", on);
}

function progScroll(el, prop, value) {
  progScrollAt = performance.now();
  el[prop] = value;
}

function catchPlayhead() {
  setFollow(true);
  const scroll = tlScroll();
  const x = video().currentTime * state.pps;
  progScroll(scroll, "scrollLeft", Math.max(0, x - (scroll.clientWidth - LABEL_W) * 0.3));
  const idx = currentCardIndex(video().currentTime);
  if (idx >= 0) scrollRowIntoList(state.cards[idx]._id, true);
}

$("#catchBtn").addEventListener("click", catchPlayhead);

["#wordsList", "#tlScroll"].forEach((sel) => {
  $(sel).addEventListener("wheel", (e) => { if (!e.ctrlKey) setFollow(false); }, { passive: true });
  $(sel).addEventListener("scroll", () => {
    if (performance.now() - progScrollAt > 150 && state.followVideo && !tlDrag && !scrubbing && !marquee) setFollow(false);
    if (sel === "#tlScroll") drawWaveform();
  });
});

function scrollRowIntoList(id, center = false) {
  const list = $("#wordsList");
  const row = rowOf(id);
  if (!row) return;
  const top = row.offsetTop - list.offsetTop;
  const bottom = top + row.offsetHeight;
  if (center || top < list.scrollTop || bottom > list.scrollTop + list.clientHeight) {
    progScroll(list, "scrollTop", Math.max(0, top - list.clientHeight / 2 + row.offsetHeight / 2));
  }
}

// ---------- words panel ----------

function renderWords() {
  const list = $("#wordsList");
  const savedScroll = list.scrollTop;
  list.innerHTML = "";
  list.classList.toggle("single-lane", laneCount() <= 1);
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
  handle.title = "Click to select - drag for a range, Shift-click to extend, Ctrl-click to add/remove";
  handle.addEventListener("mousedown", (e) => onHandleMouseDown(e, id));
  handle.addEventListener("mouseenter", () => onHandleMouseEnter(id));

  const seekBtn = document.createElement("button");
  seekBtn.className = "seek-btn";
  seekBtn.textContent = "▶";
  seekBtn.title = "Jump to this caption";
  seekBtn.addEventListener("click", (e) => { e.stopPropagation(); video().currentTime = card.start; });

  const timeInput = (cls, value, title, onChange) => {
    const el = document.createElement("input");
    el.type = "number";
    el.step = "0.01";
    el.className = "time-input " + cls;
    el.value = value.toFixed(3);
    el.title = title;
    el.addEventListener("click", (e) => e.stopPropagation());
    el.addEventListener("change", () => onChange(el));
    return el;
  };
  const startInput = timeInput("start-time", card.start, "Start (seconds)", (el) => {
    const next = parseFloat(el.value);
    if (isNaN(next) || next < 0 || next >= card.end) { el.value = card.start.toFixed(3); return; }
    applyMove([{ card, start: next, end: card.end, lane: laneOf(card) }], "edit");
  });
  const sep = document.createElement("span");
  sep.className = "time-sep";
  sep.textContent = "–";
  const endInput = timeInput("end-time", card.end, "End (seconds)", (el) => {
    const next = parseFloat(el.value);
    if (isNaN(next) || next <= card.start) { el.value = card.end.toFixed(3); return; }
    applyMove([{ card, start: card.start, end: next, lane: laneOf(card) }], "edit");
  });

  const text = document.createElement("input");
  text.className = "text";
  text.type = "text";
  text.value = cardEditorText(card);
  text.title = "What's shown in the video.   |  = line break";
  text.addEventListener("click", (e) => e.stopPropagation());
  text.addEventListener("change", () => {
    const prev = cardEditorText(card);
    const next = text.value;
    if (prev === next) return;
    applyEditorText(card, next);
    text.value = cardEditorText(card);
    const canonical = text.value;
    const toLines = (s) => s.split("|").map((l) => l.replace(/\s+/g, " ").trim());
    pushUndo({
      undo: () => { const c = cardById(id); if (c) { c.lines = toLines(prev); refreshRow(c); } },
      redo: () => { const c = cardById(id); if (c) { c.lines = toLines(canonical); refreshRow(c); } },
    });
    updateNoteChip(row, card);
    updateBlock(card);
    markDirty();
  });

  const notes = document.createElement("input");
  notes.className = "notes";
  notes.type = "text";
  notes.placeholder = "effects, colours, image links…";
  notes.value = cardNotesText(card);
  notes.title = "Instructions for whoever renders this caption - never shown in the video.";
  notes.addEventListener("click", (e) => e.stopPropagation());
  notes.addEventListener("change", () => {
    const prev = cardNotesText(card);
    const next = notes.value;
    if (prev === next) return;
    applyNotesText(card, next);
    notes.value = cardNotesText(card);
    const canonical = notes.value;
    pushUndo({
      undo: () => { const c = cardById(id); if (c) { applyNotesText(c, prev); refreshRow(c); } },
      redo: () => { const c = cardById(id); if (c) { applyNotesText(c, canonical); refreshRow(c); } },
    });
    updateNoteChip(row, card);
    updateBlock(card);
    markDirty();
  });

  const notesLabel = document.createElement("span");
  notesLabel.className = "notes-label";
  notesLabel.textContent = "PROD NOTES";

  const noteChip = document.createElement("span");
  noteChip.className = "note-chip hidden";

  const badge = document.createElement("span");
  badge.className = "speaker-badge";

  const laneSel = document.createElement("select");
  laneSel.className = "lane-select";
  laneSel.title = "Which timeline this caption is on";
  state.lanes.forEach((l, i) => {
    const o = document.createElement("option");
    o.value = i;
    o.textContent = l.name;
    laneSel.appendChild(o);
  });
  laneSel.value = String(laneOf(card));
  laneSel.addEventListener("change", () => {
    const lane = parseInt(laneSel.value, 10);
    laneSel.blur();
    applyMove([{ card, start: card.start, end: card.end, lane }], "edit");
  });

  const iconBtn = (label, title, onClick, cls = "") => {
    const b = document.createElement("button");
    b.className = "row-icon-btn " + cls;
    b.textContent = label;
    b.title = title;
    b.addEventListener("click", (e) => { e.stopPropagation(); onClick(b); });
    return b;
  };
  const emojiBtn = iconBtn("😀", "Insert emoji", (b) => openEmojiPicker(b, text));
  const insertBtn = iconBtn("+", "Add a blank caption after this one", () => insertCardAfter(id));
  const deleteBtn = iconBtn("✕", "Delete this caption", () => deleteCards([id]), "danger");

  const notesArea = document.createElement("div");
  notesArea.className = "notes-area";
  notesArea.append(notesLabel, notes);

  row.append(handle, seekBtn, startInput, sep, endInput, text, notesArea, noteChip, badge, laneSel, emojiBtn, insertBtn, deleteBtn);
  updateNoteChip(row, card);
  updateBadge(row, card);
  return row;
}

function updateNoteChip(row, card) {
  if (!row) return;
  const chip = row.querySelector(".note-chip");
  chip.classList.toggle("hidden", !card.note);
  chip.textContent = card.note ? "📝" : "";
  chip.title = card.note || "";
}

function updateBadge(row, card) {
  const badge = row.querySelector(".speaker-badge");
  badge.textContent = card.speaker || "—";
  badge.className = "speaker-badge" + (card.speaker ? "" : " unassigned");
  const sp = card.speaker ? speakerByName(card.speaker) : null;
  if (sp) { badge.style.background = sp.color; badge.style.color = "#0b0e0c"; }
  else { badge.style.background = ""; badge.style.color = ""; }
}

const rowOf = (id) => $(`.word-row[data-id="${id}"]`);

// Refresh everything shown for one card in the list and the timeline.
function refreshRow(card, flash = true) {
  const row = rowOf(card._id);
  if (row) {
    row.querySelector(".text").value = cardEditorText(card);
    row.querySelector(".notes").value = cardNotesText(card);
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
    undo: () => { const i = idxById(card._id); if (i >= 0) state.cards.splice(i, 1); clearSelection(); renderWords(); renderTimeline(); },
    redo: () => { state.cards.push(card); sortCards(); clearSelection(); renderWords(); renderTimeline(); },
  });
  markDirty();
  clearSelection();
  renderWords();
  renderTimeline();
  if (focus) {
    scrollRowIntoList(card._id, true);
    const row = rowOf(card._id);
    if (row) row.querySelector(".text").focus({ preventScroll: true });
  }
}

// Room before the next caption *on the same timeline*, so a new caption doesn't land on a neighbour.
function nextStartInLane(lane, after) {
  const nxt = state.cards.find((c) => laneOf(c) === lane && c.start > after);
  return nxt ? nxt.start : Infinity;
}

function blankCardAt(t, lane) {
  const end = Math.max(Math.min(t + 0.3, nextStartInLane(lane, t)), t + 0.05);
  const sp = state.lanes[lane] && state.lanes[lane].speaker;
  return { start: t, end, lines: [""], speaker: sp || null, ...(lane ? { lane } : {}) };
}

function insertCardAfter(id) {
  const card = cardById(id);
  addCard(blankCardAt(card.end, laneOf(card)));
}

function insertCardAtTime(t, lane = state.activeLane) {
  addCard(blankCardAt(Math.round(t * FPS) / FPS, lane));
}

function deleteCards(ids) {
  const removed = ids.map(cardById).filter(Boolean);
  if (!removed.length) return;
  const gone = new Set(removed.map((c) => c._id));
  state.cards = state.cards.filter((c) => !gone.has(c._id));
  pushUndo({
    undo: () => { state.cards.push(...removed); sortCards(); clearSelection(); renderWords(); renderTimeline(); },
    redo: () => { state.cards = state.cards.filter((c) => !gone.has(c._id)); clearSelection(); renderWords(); renderTimeline(); },
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
  "❗", "😅", "🤯", "🫡", "🍑", "🤓", "☝️", "🚕",
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
  emojiPickerEl.style.left = Math.min(rect.left, window.innerWidth - 380) + "px";
  emojiPickerEl.style.top = Math.min(rect.bottom + 4, window.innerHeight - 230) + "px";
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
  input.focus({ preventScroll: true });
  input.setSelectionRange(newPos, newPos);
  input.dispatchEvent(new Event("change", { bubbles: true })); // reuses the field's diff + undo push
  closeEmojiPicker();
}

document.addEventListener("click", (e) => {
  if (!emojiPickerEl.classList.contains("hidden") && !emojiPickerEl.contains(e.target)) closeEmojiPicker();
  if (!$("#lanesMenu").classList.contains("hidden") && !e.target.closest(".menu-wrap")) $("#lanesMenu").classList.add("hidden");
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
    el.textContent = `${state.selection.size} selected · speaker key tags all · Delete removes · Esc clears`;
    el.classList.remove("hidden");
  } else {
    el.classList.add("hidden");
  }
}

function clearSelection() {
  setSelection([], null);
}

// ---------- list drag-to-select (via the row handle only, so it can't become a text selection) ----------

let dragAnchorPos = null; // position in state.cards (sorted order)
let dragAdditive = false;
let dragBaseSelection = null;

function onHandleMouseDown(e, id) {
  e.preventDefault();
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
  if (dragAnchorPos === null) return;
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
// Every change to a caption's start/end/lane goes through applyMove (or the drag commit) so it is undoable,
// keeps the list sorted, and updates the timeline.

function applyItemSnapshots(items) {
  const cs = [];
  items.forEach((it) => {
    const c = cardById(it.id);
    if (!c) return;
    c.start = it.start;
    c.end = it.end;
    setLane(c, it.lane);
    cs.push(c);
  });
  afterTimingChange(cs);
}

// changes: [{card, start, end, lane}]. kind: "edit" | "nudge".
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
    setLane(c, ch.lane);
    changed.push(c);
  }
  if (!changed.length) return;

  const mergeKey = prevItems.map((i) => i.id).join(",");
  const last = state.undoStack[state.undoStack.length - 1];
  if (kind === "nudge" && last && last._nudgeKey === mergeKey && Date.now() - last._t < 900) {
    // holding an arrow key is one undo step, not thirty
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

function nudgeSelection(dt, dl) {
  const cards = [...state.selection].map(cardById).filter(Boolean);
  if (!cards.length) return false;
  const t = Math.max(dt, -Math.min(...cards.map((c) => c.start)));
  const l = clamp(dl, -Math.min(...cards.map(laneOf)), laneCount() - 1 - Math.max(...cards.map(laneOf)));
  applyMove(cards.map((c) => ({ card: c, start: c.start + t, end: c.end + t, lane: laneOf(c) + l })), "nudge");
  return true;
}

// ---------- timeline view ----------

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

  const row = (labelHtml, labelCls, el) => {
    const r = document.createElement("div");
    r.className = "tl-row";
    const label = document.createElement("div");
    label.className = "tl-label " + labelCls;
    label.innerHTML = labelHtml;
    r.append(label, el);
    content.appendChild(r);
    return label;
  };

  // ruler
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
  row("", "tl-corner", ruler);

  // waveform
  const wave = document.createElement("div");
  wave.className = "tl-wave";
  wave.style.width = width + "px";
  wave.innerHTML = `<canvas id="tlWave"></canvas>`;
  wave.addEventListener("mousedown", (e) => startScrub(e, wave));
  row("Audio", "tl-wave-label", wave);

  // speaker / caption timelines
  state.lanes.forEach((ln, lane) => {
    const track = document.createElement("div");
    track.className = "tl-lane-track";
    track.dataset.lane = lane;
    track.style.width = width + "px";
    track.addEventListener("mousedown", (e) => { if (e.target === track) onTrackMouseDown(e, lane, track); });
    track.addEventListener("dblclick", (e) => {
      if (e.target !== track) return;
      insertCardAtTime((e.clientX - track.getBoundingClientRect().left) / state.pps, lane);
    });
    state.cards.forEach((card) => { if (Math.min(laneOf(card), laneCount() - 1) === lane) track.appendChild(makeBlock(card)); });
    const color = laneColor(ln);
    const label = row(`<span class="dot" style="background:${color};color:${color}"></span>${esc(ln.name)}`,
      lane === state.activeLane ? "active" : "", track);
    label.title = "Click: “+ Add caption” uses this timeline";
    label.addEventListener("click", () => { state.activeLane = lane; renderTimeline(); });
  });

  const ph = document.createElement("div");
  ph.id = "tlPlayhead";
  ph.className = "tl-playhead";
  content.appendChild(ph);
  scroll.scrollLeft = sl;
  scroll.scrollTop = st;
  placePlayhead();
  drawWaveform();
}

function blockColors(card) {
  const sp = card.speaker ? speakerByName(card.speaker) : null;
  return sp ? { bg: sp.color, fg: "#0b0e0c" } : { bg: "#3a423e", fg: "#e3e8e5" };
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
  b.title = `${card.lines.join(" / ")}\n${card.start.toFixed(2)}s – ${card.end.toFixed(2)}s` + (card.note ? `\n📝 ${card.note}` : "");
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

// -- ruler / waveform scrubbing --

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
  video().currentTime = clamp((clientX - rect.left) / state.pps, 0, isFinite(dur) ? dur : Infinity);
  placePlayhead();
}

// -- empty timeline space: click = move the playhead, drag = box-select --

let marquee = null;

function onTrackMouseDown(e, lane, track) {
  if (e.button !== 0) return;
  e.preventDefault();
  state.activeLane = lane;
  document.querySelectorAll(".tl-label").forEach((l) => l.classList.remove("active"));
  track.previousSibling.classList.add("active");
  marquee = {
    x0: e.clientX, y0: e.clientY, moved: false, track,
    base: e.ctrlKey || e.metaKey ? new Set(state.selection) : new Set(),
    el: null,
  };
}

function updateMarquee(e) {
  const m = marquee;
  if (!m.moved && Math.hypot(e.clientX - m.x0, e.clientY - m.y0) < 4) return;
  if (!m.moved) {
    m.moved = true;
    m.el = document.createElement("div");
    m.el.className = "tl-marquee";
    tlContent().appendChild(m.el);
  }
  const box = tlContent().getBoundingClientRect();
  const l = Math.min(m.x0, e.clientX), r = Math.max(m.x0, e.clientX);
  const t = Math.min(m.y0, e.clientY), b = Math.max(m.y0, e.clientY);
  Object.assign(m.el.style, { left: l - box.left + "px", top: t - box.top + "px", width: r - l + "px", height: b - t + "px" });
  const sel = new Set(m.base);
  document.querySelectorAll(".tl-block").forEach((el) => {
    const rb = el.getBoundingClientRect();
    if (rb.right > l && rb.left < r && rb.bottom > t && rb.top < b) sel.add(+el.dataset.id);
  });
  setSelection(sel, state.lastSelectedId);
}

function endMarquee(e) {
  const m = marquee;
  marquee = null;
  if (m.el) m.el.remove();
  if (!m.moved) {
    if (!(e.ctrlKey || e.metaKey)) clearSelection();
    const rect = m.track.getBoundingClientRect();
    const dur = video().duration;
    video().currentTime = clamp((e.clientX - rect.left) / state.pps, 0, isFinite(dur) ? dur : Infinity);
    placePlayhead();
  }
}

// -- dragging captions on the timeline --
// Plain drag slides in time (and can change timeline); holding Shift locks the time so it only moves
// between timelines. Shift-click without dragging extends the selection.

let tlDrag = null;
const DRAG_THRESHOLD_PX = 3;

function onBlockMouseDown(e, id) {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  const card = cardById(id);
  const edge = e.target.classList.contains("tl-hl") ? "l" : e.target.classList.contains("tl-hr") ? "r" : null;

  let collapseOnClick = false;
  let shiftClick = false;
  if (e.ctrlKey || e.metaKey) {
    const next = new Set(state.selection);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelection(next, id);
  } else if (e.shiftKey && !edge) {
    shiftClick = true; // decided on mouseup: no drag = extend selection, drag = move between timelines
    if (!state.selection.has(id)) setSelection([...state.selection, id], state.lastSelectedId ?? id);
  } else if (!state.selection.has(id)) {
    setSelection([id], id);
  } else {
    collapseOnClick = state.selection.size > 1 && !edge;
    state.lastSelectedId = id;
  }
  state.activeLane = laneOf(card);

  const movers = edge ? [card] : [...state.selection].map(cardById).filter(Boolean);
  tlDrag = {
    id, edge, collapseOnClick, shiftClick, moved: false,
    startX: e.clientX, grabLane: laneOf(card),
    orig: new Map(movers.map((c) => [c._id, { start: c.start, end: c.end, lane: laneOf(c) }])),
  };
}

document.addEventListener("mousemove", (e) => {
  if (scrubbing) { scrubTo(e.clientX); return; }
  if (marquee) { updateMarquee(e); return; }
  if (!tlDrag) return;
  const dx = e.clientX - tlDrag.startX;
  if (!tlDrag.moved && Math.abs(dx) < DRAG_THRESHOLD_PX && laneAtY(e.clientY) === tlDrag.grabLane) return;
  tlDrag.moved = true;

  let dt = e.shiftKey && !tlDrag.edge ? 0 : dx / state.pps; // Shift: timeline change only, time stays put
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
    laneCount() - 1 - Math.max(...origs.map((o) => o.lane)));
  ids.forEach((id) => {
    const c = cardById(id), o = tlDrag.orig.get(id);
    c.start = o.start + t;
    c.end = o.end + t;
    const lane = o.lane + dl;
    setLane(c, lane);
    const b = $(`.tl-block[data-id="${id}"]`);
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

document.addEventListener("mouseup", (e) => {
  scrubbing = null;
  if (marquee) { endMarquee(e); return; }
  if (!tlDrag) return;
  const d = tlDrag;
  tlDrag = null;
  if (!d.moved) {
    if (d.shiftClick && state.lastSelectedId !== null && idxById(state.lastSelectedId) >= 0) {
      const [lo, hi] = [idxById(state.lastSelectedId), idxById(d.id)].sort((a, b) => a - b);
      setSelection(state.cards.slice(lo, hi + 1).map((c) => c._id), d.id);
    } else if (d.collapseOnClick) {
      setSelection([d.id], d.id);
    }
    const c = cardById(d.id);
    if (c) { video().currentTime = c.start; placePlayhead(); } // a plain click also cues the video there
    return;
  }
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
  pushUndo({ undo: () => applyItemSnapshots(prevItems), redo: () => applyItemSnapshots(nextItems) });
  markDirty();
  afterTimingChange(changed);
});

// -- zoom (always centred on the playhead) --

const ppsToSlider = (pps) => Math.round(1000 * Math.log(pps / PPS_MIN) / Math.log(PPS_MAX / PPS_MIN));
const sliderToPps = (v) => PPS_MIN * Math.pow(PPS_MAX / PPS_MIN, v / 1000);

function setZoom(pps) {
  const scroll = tlScroll();
  const t = video().currentTime;
  const view = scroll.clientWidth - LABEL_W;
  let offset = t * state.pps - scroll.scrollLeft; // where the playhead sits on screen
  if (offset < 0 || offset > view) offset = view / 2; // off screen: bring it to the middle
  state.pps = clamp(pps, PPS_MIN, PPS_MAX);
  $("#tlZoom").value = ppsToSlider(state.pps);
  renderTimeline();
  progScroll(scroll, "scrollLeft", Math.max(0, t * state.pps - offset));
  drawWaveform();
}

$("#tlZoomIn").addEventListener("click", () => setZoom(state.pps * 1.35));
$("#tlZoomOut").addEventListener("click", () => setZoom(state.pps / 1.35));
$("#tlZoom").addEventListener("input", (e) => setZoom(sliderToPps(+e.target.value)));
$("#tlZoom").value = ppsToSlider(state.pps);
$("#tlScroll").addEventListener("wheel", (e) => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  setZoom(state.pps * (e.deltaY < 0 ? 1.2 : 1 / 1.2));
}, { passive: false });
window.addEventListener("resize", () => drawWaveform());

// -- show / hide / add timelines --

function renderLanesMenu() {
  const menu = $("#lanesMenu");
  const items = [];
  state.lanes.forEach((l, i) => {
    const n = state.cards.filter((c) => laneOf(c) === i).length;
    const canHide = n === 0 && laneCount() > 1;
    items.push(`<div class="menu-item${canHide ? "" : " disabled"}" data-hide="${i}" title="${canHide ? "Hide this timeline" : n ? "Has captions - move them off to hide it" : "The last timeline can't be hidden"}">
      <span class="check">✓</span><span class="dot" style="background:${laneColor(l)}"></span>${esc(l.name)}<span class="meta">${n}</span></div>`);
  });
  state.speakers.filter((s) => !state.lanes.some((l) => l.speaker === s.name)).forEach((s) => {
    items.push(`<div class="menu-item" data-show="${esc(s.name)}" title="Show ${esc(s.name)}'s timeline">
      <span class="check"></span><span class="dot" style="background:${s.color}"></span>${esc(s.name)}<span class="meta">hidden</span></div>`);
  });
  items.push(`<div class="menu-sep"></div><div class="menu-item" data-add="1"><span class="check">+</span>Add new timeline</div>`);
  menu.innerHTML = items.join("");
  menu.querySelectorAll("[data-hide]").forEach((el) => el.addEventListener("click", () => {
    if (!el.classList.contains("disabled")) hideLane(+el.dataset.hide);
  }));
  menu.querySelectorAll("[data-show]").forEach((el) => el.addEventListener("click", () => {
    const before = snapshotLayout();
    state.lanes.push({ name: el.dataset.show, speaker: el.dataset.show });
    pushLayoutUndo(before);
    afterLanesChange();
  }));
  menu.querySelector("[data-add]").addEventListener("click", () => {
    const name = (prompt("Name for the new timeline:", `Timeline ${laneCount() + 1}`) || "").trim();
    if (!name) return;
    const before = snapshotLayout();
    state.lanes.push({ name, speaker: null });
    pushLayoutUndo(before);
    afterLanesChange();
  });
}

function hideLane(i) {
  const before = snapshotLayout();
  state.lanes.splice(i, 1);
  state.cards.forEach((c) => { if (laneOf(c) > i) setLane(c, laneOf(c) - 1); });
  state.activeLane = Math.min(state.activeLane, laneCount() - 1);
  pushLayoutUndo(before);
  afterLanesChange();
}

function afterLanesChange() {
  markDirty();
  renderWords();
  renderTimeline();
  renderLanesMenu();
}

$("#lanesBtn").addEventListener("click", (e) => {
  e.stopPropagation();
  const menu = $("#lanesMenu");
  menu.classList.toggle("hidden");
  if (!menu.classList.contains("hidden")) renderLanesMenu();
});

// ---------- undo / redo ----------
// Every mutating action pushes {undo(), redo()} - both closures replay exactly what the edit did. History
// is capped at MAX_HISTORY steps each way; a new edit clears the redo branch.

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
  $("#undoBtn").disabled = state.undoStack.length === 0;
  $("#redoBtn").disabled = state.redoStack.length === 0;
}

$("#undoBtn").addEventListener("click", undoLast);
$("#redoBtn").addEventListener("click", redoLast);
updateHistoryButtons();

// ---------- current caption lookup & tagging ----------

const REACTION_LEEWAY = 0.35; // seconds of tolerance for a slightly-late keypress

// The caption a "tag the current word" keypress means: the most recently started one (any timeline).
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

// Tag captions with a speaker and move them onto that speaker's timeline (unhiding it on first use).
function assignSpeaker(name) {
  const targets = state.selection.size > 0
    ? [...state.selection].map(cardById).filter(Boolean)
    : (() => { const i = currentCardIndex(video().currentTime); return i < 0 ? [] : [state.cards[i]]; })();
  const todo = targets.filter((c) => c.speaker !== name || state.lanes[laneOf(c)]?.speaker !== name);
  if (todo.length) {
    const before = snapshotLayout();
    const lane = laneForSpeaker(name);
    todo.forEach((c) => { c.speaker = name; setLane(c, lane); });
    pushLayoutUndo(before);
    markDirty();
    sortCards();
    renderWords();
    renderTimeline();
    todo.forEach((c) => refreshRow(c));
  }
  if (state.selection.size > 0) clearSelection(); // tagging closes out a selection
  else if (todo.length && state.followVideo) scrollRowIntoList(todo[0]._id);
}

// ---------- keys ----------

function isTypingTarget(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

const openModal = () => [...document.querySelectorAll(".modal")].find((m) => !m.classList.contains("hidden"));

document.addEventListener("keydown", (e) => {
  if ($("#editor").classList.contains("hidden")) return;
  const modal = openModal();
  if (e.key === "Escape" && modal && modal.id !== "speakerModal") { modal.classList.add("hidden"); blurFocused(); return; }
  if (isTypingTarget(document.activeElement) || modal) return;

  const v = video();
  if (e.key === " ") { e.preventDefault(); v.paused ? v.play() : v.pause(); return; }
  if (e.key === "<" || e.key === ",") { e.preventDefault(); v.currentTime = Math.max(0, v.currentTime - 5); return; }
  if (e.key === ">" || e.key === ".") { e.preventDefault(); v.currentTime = Math.min(v.duration || Infinity, v.currentTime + 5); return; }
  if (e.key === "Enter") { e.preventDefault(); v.currentTime = 0; return; }
  if (e.key === "Backspace") { e.preventDefault(); if (e.shiftKey) redoLast(); else undoLast(); return; }
  if (e.key === "Delete") { e.preventDefault(); deleteCards([...state.selection]); return; }
  if (e.key === "Escape") {
    e.preventDefault();
    clearSelection();
    $("#lanesMenu").classList.add("hidden");
    return;
  }
  if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
    if (state.selection.size) {
      e.preventDefault();
      const frames = e.shiftKey ? 10 : 1;
      nudgeSelection((e.key === "ArrowLeft" ? -frames : frames) / FPS, 0);
    }
    return;
  }
  if (e.key === "ArrowUp" || e.key === "ArrowDown") {
    if (state.selection.size) { e.preventDefault(); nudgeSelection(0, e.key === "ArrowUp" ? -1 : 1); }
    return;
  }
  const sp = state.speakers.find((s) => s.key === e.key.toLowerCase());
  if (sp && !e.ctrlKey && !e.altKey && !e.metaKey) {
    e.preventDefault();
    assignSpeaker(sp.name);
  }
});

// ---------- live preview ----------
// Mirrors the renderer: whichever timeline is showing a caption highest up draws big on the seam, any
// others showing at the same moment stack smaller underneath.

function updateOverlay() {
  const t = video().currentTime;
  const overlay = $("#overlay");
  const active = [];
  for (let lane = 0; lane < laneCount(); lane++) {
    const card = currentCardInLane(t, lane);
    if (card && t <= card.end + 0.4 && card.lines.join("").trim()) active.push(card);
  }
  const key = active.map((c) => c._id + ":" + c.lines.join("|") + ":" + c.speaker).join(",");
  if (overlay.dataset.key !== key) {
    overlay.dataset.key = key;
    overlay.innerHTML = active.map((c, i) => {
      const sp = c.speaker ? speakerByName(c.speaker) : null;
      return `<div class="ov-line${i ? " ov-sub" : ""}" style="color:${sp ? sp.color : "#fff"}">${esc(c.lines.join("\n").toUpperCase())}</div>`;
    }).join("");
  }

  const idx = currentCardIndex(t);
  document.querySelectorAll(".word-row.current").forEach((r) => r.classList.remove("current"));
  if (idx < 0 || t > state.cards[idx].end + 0.4) return;
  const row = rowOf(state.cards[idx]._id);
  if (row) {
    row.classList.add("current");
    if (state.followVideo && !video().paused) scrollRowIntoList(state.cards[idx]._id);
  }
}

function followTimeline() {
  if (!state.followVideo || tlDrag || scrubbing || marquee) return;
  const scroll = tlScroll();
  const x = video().currentTime * state.pps;
  const view = scroll.clientWidth - LABEL_W;
  if (x < scroll.scrollLeft + 10 || x > scroll.scrollLeft + view - 40) {
    progScroll(scroll, "scrollLeft", Math.max(0, x - view * 0.25));
  }
}

function tick() {
  const v = video();
  if (v.duration && !$("#editor").classList.contains("hidden")) {
    updateOverlay();
    placePlayhead();
    followTimeline();
    if (!state.dragging) $("#seekBar").value = Math.round((v.currentTime / v.duration) * 1000);
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
  if (strayStar > 0 && !confirm(`${strayStar} caption${strayStar > 1 ? "s contain" : " contains"} a lone * that would show in the video. Save anyway?`)) return;
  // A card with no text but a production note is a supported "silent" note-only card; only a card with
  // neither is pointless.
  const emptyCount = state.cards.filter((c) => !c.lines.join("").trim() && !c.note).length;
  if (emptyCount > 0 && !confirm(`${emptyCount} caption${emptyCount > 1 ? "s have" : " has"} neither text nor a production note, so it won't do anything. Save anyway?`)) return;
  if (!state.speakersHandle) {
    try {
      state.speakersHandle = await window.showSaveFilePicker({
        suggestedName: state.cardsHandle.name.replace(/\.json$/i, "") + "_speakers.json",
        types: JSON_TYPES,
      });
    } catch (e) {
      if (e.name === "AbortError") return; // cancelled - keep the edits
      alert("Couldn't create the speakers file: " + e.message);
      return;
    }
  }
  if (!(await ensureReadWrite(state.speakersHandle))) {
    alert("Write permission for the speakers file was denied.");
    return;
  }

  sortCards();
  const bakedCards = state.cards.map((c) => {
    // Carry through any field the editor doesn't manage (fx, emphasis_scale, ...) so saving never strips
    // data another tool put on a card.
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
      out.fill = c.fill;
    }
    return out;
  });
  const sidecar = { font: state.font, speakers: state.speakers, lanes: state.lanes };
  if (state.fontFile) sidecar.font_file = state.fontFile;

  try {
    const cardsWritable = await state.cardsHandle.createWritable();
    await cardsWritable.write(JSON.stringify(bakedCards, null, 2));
    await cardsWritable.close();
    const spWritable = await state.speakersHandle.createWritable();
    await spWritable.write(JSON.stringify(sidecar, null, 2));
    await spWritable.close();
  } catch (e) {
    alert("Save failed: " + e.message);
    return;
  }

  saveSettingsSoon();
  markDirty(false);
  $("#speakersPathLabel").textContent = state.speakersHandle.name;
  $("#speakersPathLabel").classList.add("chosen");
  const btn = $("#saveBtn");
  btn.textContent = "Saved ✓";
  setTimeout(() => { btn.textContent = "Save"; }, 1200);
});

window.addEventListener("beforeunload", (e) => {
  if (state.dirty) { e.preventDefault(); e.returnValue = ""; }
});
