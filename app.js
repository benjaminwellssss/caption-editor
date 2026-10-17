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
  trims: [],               // [[start, end], ...] stretches cut out of the video at render time (sorted, merged)
  trimSel: null,           // [start, end] selected on the Audio row, waiting for ✂ Trim
  voiceOverlay: true,      // draw the "who's talking" overlay in the facecam
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

// Speakers from a file or settings.json may be hand-edited: keep only usable entries, lower-case the hotkey
// (the key handler compares lower-case), and make sure the colour is a #rrggbb the UI and hexToRgba can use.
function normalizeSpeakers(list) {
  const seen = new Set();
  return list.filter((s) => s && typeof s === "object" && typeof s.name === "string" && s.name.trim()).map((s) => {
    const sp = { ...s, name: s.name.trim(), key: String(s.key ?? "").trim().toLowerCase().slice(0, 1) };
    if (!/^#[0-9a-f]{6}$/i.test(String(sp.color))) sp.color = "#8cff78";
    return sp;
  }).filter((s) => { if (seen.has(s.name)) return false; seen.add(s.name); return true; });
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
  if (!settings || typeof settings !== "object") settings = {};
  state.favoriteFonts = Array.isArray(settings.favoriteFonts) ? settings.favoriteFonts : [];
  const d = settings.defaultFont;
  state.defaultFont = d && typeof d.family === "string" && d.family ? { family: d.family, file: d.file || null } : null;
}

function settingsPayload() {
  return JSON.stringify({ speakers: state.speakers, favoriteFonts: state.favoriteFonts, defaultFont: state.defaultFont });
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

const settingsReady = loadSettings(); // loadProject waits on this so a slow /settings can't lose the roster

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
  if (parsed.note) card.note = card.note && card.note !== parsed.note ? `${card.note}; ${parsed.note}` : parsed.note;
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

// The folder every file dialog opens in. Browsers can't be pointed at a typed path, so you pick it once
// (your clips folder) and the handle is kept in IndexedDB for next time.
const idb = (mode, fn) => new Promise((resolve) => {
  const open = indexedDB.open("cabtions", 1);
  open.onupgradeneeded = () => open.result.createObjectStore("kv");
  open.onsuccess = () => {
    const req = fn(open.result.transaction("kv", mode).objectStore("kv"));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  };
  open.onerror = () => resolve(null);
});
let startDir = null;
idb("readonly", (st) => st.get("startDir")).then((h) => {
  startDir = h || null;
  if (startDir) { $("#startDirLabel").textContent = startDir.name; $("#startDirLabel").classList.add("chosen"); }
});

$("#startDirBtn").addEventListener("click", async () => {
  try {
    const h = await window.showDirectoryPicker({ id: "cabtions-start", startIn: startDir || "videos" });
    startDir = h;
    await idb("readwrite", (st) => st.put(h, "startDir"));
    $("#startDirLabel").textContent = h.name;
    $("#startDirLabel").classList.add("chosen");
  } catch (e) {
    if (e.name !== "AbortError") console.error(e);
  }
});

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
    // captions and speakers open in the video's own folder once a video is picked; the video starts in the
    // default folder (passing a file handle as startIn opens the folder that file is in)
    const startIn = target !== "video" && state.videoHandle ? state.videoHandle : startDir || "videos";
    const [handle] = await window.showOpenFilePicker({ types, multiple: false, startIn });
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

// Lanes from a fresh caption file: Timeline 1 and 2 are always the first two roster speakers (Ben, Jared),
// then every other speaker who's tagged, in roster order. Untagged captions go on Timeline 1.
function organizeBySpeaker() {
  const present = new Set(state.cards.map((c) => c.speaker).filter(Boolean));
  const rank = (n) => { const i = state.speakers.findIndex((s) => s.name === n); return i < 0 ? 1e6 : i; };
  const order = state.speakers.slice(0, 2).map((s) => s.name);
  [...present].sort((a, b) => rank(a) - rank(b)).forEach((n) => { if (!order.includes(n)) order.push(n); });
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
    if (!Array.isArray(cards)) throw new Error("expected a JSON list of caption cards");
    cards.forEach((c, i) => { if (!c || typeof c !== "object" || typeof c.start !== "number" || typeof c.end !== "number") throw new Error(`card ${i + 1} has no start/end`); });
  } catch (e) {
    errEl.textContent = "Could not read cards.json: " + e.message;
    return;
  }

  let speakers = [];
  let font = null; // the video's own saved font wins; otherwise the ♥ default (below), then DEFAULT_FONT
  let fontFile = null;
  let savedLanes = null;
  let trims = [];
  let voiceOverlay = true;
  if (state.speakersHandle) {
    try {
      const parsed = JSON.parse(await (await state.speakersHandle.getFile()).text());
      // Old files are a plain speakers array; newer ones are {font, font_file?, speakers, lanes?}.
      if (Array.isArray(parsed)) {
        speakers = parsed;
      } else if (parsed && typeof parsed === "object") {
        speakers = Array.isArray(parsed.speakers) ? parsed.speakers : [];
        if (parsed.font) font = parsed.font;
        if (parsed.font_file) fontFile = parsed.font_file;
        if (Array.isArray(parsed.lanes) && parsed.lanes.length) savedLanes = parsed.lanes;
        if (Array.isArray(parsed.trims)) trims = parsed.trims.filter((r) => Array.isArray(r) && r[1] > r[0]);
        if (parsed.voice_overlay === false) voiceOverlay = false;
      }
    } catch (e) {
      errEl.textContent = "Could not read speakers.json: " + e.message;
      return;
    }
  }
  await settingsReady;
  if (!font) {
    font = state.defaultFont ? state.defaultFont.family : DEFAULT_FONT;
    fontFile = state.defaultFont && !FONTS.includes(font) ? state.defaultFont.file : null;
  }
  speakers = normalizeSpeakers(speakers);
  if (speakers.length === 0) {
    speakers = normalizeSpeakers(Array.isArray(settings.speakers) && settings.speakers.length ? settings.speakers : DEFAULT_SPEAKERS);
  }

  if (!(await ensureReadWrite(state.cardsHandle))) {
    errEl.textContent = "Write permission for cards.json was denied, so changes couldn't be saved.";
    return;
  }

  let migrated = false;
  state.cards = cards.map((c) => {
    const lines = Array.isArray(c.lines) ? c.lines.map((l) => String(l ?? "")) : [String(c.text ?? "")];
    const card = { ...c, _id: nextId++, lines, speaker: typeof c.speaker === "string" && c.speaker ? c.speaker : null };
    if (card.end < card.start) [card.start, card.end] = [card.end, card.start];
    if (!(card.lane > 0)) delete card.lane; else card.lane = Math.floor(card.lane);
    const before = JSON.stringify([card.lines, card.note || null]);
    applyEditorText(card, cardEditorText(card));
    if (JSON.stringify([card.lines, card.note || null]) !== before) migrated = true;
    return card;
  });
  state.speakers = speakers;

  const maxLane = Math.max(0, ...state.cards.map(laneOf));
  if (savedLanes) {
    state.lanes = savedLanes.map((l, i) => (typeof l === "string" ? { name: l, speaker: null }
      : { name: (l && l.name) || `Timeline ${i + 1}`, speaker: (l && typeof l.speaker === "string" && l.speaker) || null, ...(l && l.hidden ? { hidden: true } : {}) }));
  } else if (maxLane === 0) {
    organizeBySpeaker(); // first open of a fresh caption file: put each speaker on their own timeline
    migrated = true;
  } else {
    state.lanes = [];
  }
  while (state.lanes.length <= maxLane) state.lanes.push({ name: `Timeline ${state.lanes.length + 1}`, speaker: null });
  if (state.lanes.every((l) => l.hidden)) delete state.lanes[0].hidden; // a hand-edited file can't hide every timeline

  sortCards();
  state.activeLane = Math.max(0, state.lanes.findIndex((l) => !l.hidden));
  state.font = font;
  state.fontFile = fontFile;
  state.trims = trims;
  state.trimSel = null;
  state.voiceOverlay = voiceOverlay;
  $("#voiceToggle").checked = voiceOverlay;
  renderFontButton();
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
  video().pause();
  $("#editor").classList.add("hidden");
  $("#setup").classList.remove("hidden");
});

video().addEventListener("loadedmetadata", () => renderTimeline());

// ---------- audio waveform ----------
// Decodes the video's own audio track in the browser and keeps one peak level per 1/PEAK_RATE s, so spikes
// (sibilance, plosives, laughs) line up with the captions on the same time scale.

async function loadWaveform(file) {
  state.peaks = null;
  let ctx = null;
  try {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    const audio = await ctx.decodeAudioData(await file.arrayBuffer());
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
  } finally {
    if (ctx) ctx.close().catch(() => {});
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
      <span class="key">${esc((sp.key || "?").toUpperCase())}</span> ${esc(sp.name)}`;
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
  pendingSpeakerFont = isNew ? { family: null, file: null } : { family: state.speakers[idx].font || null, file: state.speakers[idx].font_file || null };
  renderSpeakerFontButton();
  $("#spHandle").value = isNew ? "" : state.speakers[idx].handle || "";
  pendingAvatar = isNew ? null : state.speakers[idx].avatar || null;
  renderSpeakerAvatar();
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
  updateDoneTyping(); // focusout doesn't always fire while the window is in the background
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
  const sp = { name, key, color };
  if (pendingSpeakerFont.family) sp.font = pendingSpeakerFont.family;
  if (pendingSpeakerFont.file) sp.font_file = pendingSpeakerFont.file;
  const handle = $("#spHandle").value.trim().replace(/^@/, "");
  if (handle) sp.handle = handle;
  if (pendingAvatar) sp.avatar = pendingAvatar;
  if (state.editingSpeakerIdx === null) {
    state.speakers.push(sp);
  } else {
    const oldName = state.speakers[state.editingSpeakerIdx].name;
    state.speakers[state.editingSpeakerIdx] = sp;
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
// The video font and each speaker's own font are picked from every installed font in one browser. Previews
// use the browser's own access to installed fonts (CSS family names), so the list scrolls without loading
// font files; a font from settings.json "font_dirs" (not installed) falls back to loading its file.

let fontIndex = null;      // /fonts list, fetched the first time the browser opens
let fontPickTarget = null; // "video", or the speaker being edited

const cssFamily = (family) => `"${family.replace(/"/g, "")}"`;

// Is this family available to the browser? document.fonts.check() says yes for any name with no @font-face
// (it only reports on loadable fonts), so measure instead: a family that falls back to both monospace and
// serif renders the probe at both of their widths, which differ.
const fontProbe = document.createElement("canvas").getContext("2d");
const fontProbeCache = new Map();
function fontInstalled(family) {
  if (fontProbeCache.has(family)) return fontProbeCache.get(family);
  const width = (font) => { fontProbe.font = `32px ${font}`; return fontProbe.measureText("mmmmmmmmmmlli1WWW").width; };
  const fam = cssFamily(family);
  const installed = width(`${fam}, monospace`) !== width("monospace") || width(`${fam}, serif`) !== width("serif");
  fontProbeCache.set(family, installed);
  return installed;
}

function renderFontButton() {
  const b = $("#fontPickerBtn");
  b.textContent = state.font + "  ▾";
  b.style.fontFamily = `${cssFamily(state.font)}, var(--sans)`;
}

function setFont(family, file) {
  const fontFile = FONTS.includes(family) ? null : (file || null);
  if (state.font === family && state.fontFile === fontFile) return;
  state.font = family;
  state.fontFile = fontFile;
  renderFontButton();
  markDirty(true);
}

async function getFontIndex() {
  if (!fontIndex) {
    try {
      const list = await (await fetch("/fonts")).json();
      fontIndex = Array.isArray(list) ? list : [];
    } catch { fontIndex = []; }
  }
  return fontIndex;
}

async function openFontBrowser(target) {
  fontPickTarget = target;
  $("#fontModalHint").textContent = target === "video"
    ? "Click a font to use it for this video. ★ pins it to the top of the list. ♥ makes it the default for every video (and uses it here)."
    : `Click a font for ${$("#spName").value || "this speaker"}'s captions. ★ pins it to the top of the list. ♥ makes it the default video font.`;
  $("#fontModal").classList.remove("hidden");
  $("#fontSearch").value = "";
  $("#fontSearch").focus();
  if (!fontIndex) $("#fontList").innerHTML = `<p class="hint">Reading installed fonts…</p>`;
  await getFontIndex();
  renderFontList();
}

$("#fontPickerBtn").addEventListener("click", () => openFontBrowser("video"));
$("#fontModalClose").addEventListener("click", () => { $("#fontModal").classList.add("hidden"); });
$("#fontSearch").addEventListener("input", () => renderFontList());
$("#fontSample").addEventListener("input", () => {
  document.querySelectorAll(".font-item .fsample").forEach((el) => { el.textContent = $("#fontSample").value; });
});

const faceObserver = new IntersectionObserver((entries) => {
  entries.forEach((en) => {
    if (!en.isIntersecting) return;
    faceObserver.unobserve(en.target);
    const i = en.target.dataset.i;
    const f = fontIndex[+i];
    const sample = en.target.querySelector(".fsample");
    sample.style.fontFamily = `${cssFamily(f.family)}, var(--sans)`;
    if (!fontInstalled(f.family)) { // not installed (a font_dirs file): load it
      new FontFace(`cabpv${i}`, `url(/fontfile?i=${i})`).load()
        .then((face) => { document.fonts.add(face); sample.style.fontFamily = `cabpv${i}`; }).catch(() => {});
    }
  });
}, { root: $("#fontList"), rootMargin: "200px" });

function renderFontList() {
  const q = $("#fontSearch").value.trim().toLowerCase();
  const sample = esc($("#fontSample").value);
  const seen = new Set();
  const rows = [];
  (fontIndex || []).forEach((f, i) => {
    if (seen.has(f.family) || (q && !f.family.toLowerCase().includes(q))) return;
    seen.add(f.family); // one row per family, its Regular (or first) style
    rows.push({ ...f, i, fav: state.favoriteFonts.some((x) => x.family === f.family) });
  });
  rows.sort((a, b) => b.fav - a.fav); // pinned first, then alphabetical (the server sorts)
  const current = fontPickTarget === "video" ? state.font : pendingSpeakerFont.family;
  const defaultFamily = state.defaultFont ? state.defaultFont.family : null;
  const shown = rows.slice(0, 600);
  const list = $("#fontList");
  list.innerHTML = shown.map((f) => `<div class="font-item${f.family === current ? " current" : ""}" data-i="${f.i}">
      <span class="star${f.fav ? " on" : ""}" title="Pin to the top">${f.fav ? "★" : "☆"}</span>
      <span class="heart${f.family === defaultFamily ? " on" : ""}" title="Default font: every video without its own font opens in this one">${f.family === defaultFamily ? "♥" : "♡"}</span>
      <span class="fname">${esc(f.family)}</span><span class="fsample">${sample}</span></div>`).join("")
    + (rows.length > shown.length ? `<p class="hint">${rows.length - shown.length} more: type to narrow down</p>` : "");
  list.querySelectorAll(".font-item").forEach((el) => {
    const f = fontIndex[+el.dataset.i];
    faceObserver.observe(el);
    el.querySelector(".star").addEventListener("click", (e) => {
      e.stopPropagation();
      const k = state.favoriteFonts.findIndex((x) => x.family === f.family);
      if (k >= 0) state.favoriteFonts.splice(k, 1); else state.favoriteFonts.push({ family: f.family, file: f.file });
      saveSettingsSoon();
      renderFontList();
    });
    el.querySelector(".heart").addEventListener("click", (e) => {
      e.stopPropagation();
      const was = state.defaultFont && state.defaultFont.family === f.family;
      state.defaultFont = was ? null : { family: f.family, file: f.file };
      if (!was && fontPickTarget === "video") setFont(f.family, f.file);
      saveSettingsSoon();
      renderFontList();
    });
    el.addEventListener("click", () => {
      if (fontPickTarget === "video") setFont(f.family, f.file);
      else { pendingSpeakerFont = { family: f.family, file: FONTS.includes(f.family) ? null : f.file }; renderSpeakerFontButton(); }
      $("#fontModal").classList.add("hidden");
    });
  });
}

// the speaker editor's font choice, applied when the speaker is saved
let pendingSpeakerFont = { family: null, file: null };

function renderSpeakerFontButton() {
  const b = $("#spFontBtn");
  b.textContent = (pendingSpeakerFont.family || "Same as the video") + "  ▾";
  b.style.fontFamily = pendingSpeakerFont.family ? `${cssFamily(pendingSpeakerFont.family)}, var(--sans)` : "";
}

$("#spFontBtn").addEventListener("click", () => openFontBrowser("speaker"));
$("#spFontClear").addEventListener("click", () => { pendingSpeakerFont = { family: null, file: null }; renderSpeakerFontButton(); });

// ---------- speaker profile pictures (for the voice overlay) ----------
// Picked with the normal file dialog, uploaded to the server, which keeps a square copy in its git-ignored
// avatars/ folder. The speaker stores that file's path, which the renderer reads.

let pendingAvatar = null;
const avatarUrl = (path) => path ? "/avatars/" + encodeURIComponent(path.split(/[\\/]/).pop()) + "?v=" + avatarBust : "";
let avatarBust = Date.now();

function renderSpeakerAvatar() {
  const img = $("#spAvatarImg");
  img.src = pendingAvatar ? avatarUrl(pendingAvatar) : "";
  img.classList.toggle("empty", !pendingAvatar);
}

$("#spAvatarBtn").addEventListener("click", async () => {
  const name = $("#spName").value.trim();
  if (!name) { $("#speakerFormError").textContent = "Give the speaker a name first."; return; }
  try {
    const [h] = await window.showOpenFilePicker({ types: [{ description: "Picture", accept: { "image/*": [".png", ".jpg", ".jpeg", ".webp", ".gif"] } }] });
    const res = await fetch("/avatar?name=" + encodeURIComponent(name), { method: "POST", body: await h.getFile() });
    if (!res.ok) throw new Error(await res.text());
    pendingAvatar = (await res.json()).path;
    avatarBust = Date.now();
    renderSpeakerAvatar();
  } catch (e) {
    if (e.name !== "AbortError") $("#speakerFormError").textContent = "Couldn't use that picture: " + e.message;
  }
});
$("#spAvatarClear").addEventListener("click", () => { pendingAvatar = null; renderSpeakerAvatar(); });

// the font a caption previews in: its speaker's own font, else the video's
function cardFontFamily(card) {
  const sp = card.speaker ? speakerByName(card.speaker) : null;
  return `${cssFamily(sp && sp.font ? sp.font : state.font)}, Impact, "Arial Black", sans-serif`;
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
  const gifBtn = iconBtn("GIF", "Search GIPHY and put a GIF link in this caption's PROD NOTES", (b) => openGifPicker(notes, card, b), "gif-btn");
  const fxBtn = iconBtn("FX", "Add a text-effect preset to this caption's PROD NOTES", (b) => openFxPicker(notes, b), "gif-btn fx-btn");
  const insertBtn = iconBtn("+", "Add a blank caption after this one", () => insertCardAfter(id));
  const deleteBtn = iconBtn("✕", "Delete this caption", () => deleteCards([id]), "danger");

  const notesArea = document.createElement("div");
  notesArea.className = "notes-area";
  notesArea.append(notesLabel, notes);

  row.append(handle, seekBtn, startInput, sep, endInput, text, notesArea, noteChip, badge, laneSel, emojiBtn, gifBtn, fxBtn, insertBtn, deleteBtn);
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
  return card;
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

function insertCardAfter(id, focus = true) {
  const card = cardById(id);
  return addCard(blankCardAt(card.end, laneOf(card)), focus);
}

function insertCardAtTime(t, lane = state.activeLane, focus = true) {
  return addCard(blankCardAt(Math.round(t * FPS) / FPS, lane), focus);
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

// ---------- GIF search (GIPHY) ----------
// Needs a GIPHY API key as "giphy_key" in settings.json next to server.py (local only, never committed).
// Clicking a result appends its link to the caption's PROD NOTES; the renderer downloads note links.

let gifTarget = null;
let gifTimer = null;
let gifSeq = 0; // a slow earlier search must not overwrite the results of a later one

function openGifPicker(notesInput, card, anchor) {
  gifTarget = notesInput;
  $("#gifModalTitle").textContent = `GIF for “${card.lines.join(" ") || "blank caption"}”`;
  placePop($("#gifPop"), anchor.getBoundingClientRect());
  const q = $("#gifSearch");
  q.value = card.lines.join(" ").toLowerCase();
  q.focus();
  q.select();
  searchGifs();
}

async function searchGifs() {
  const grid = $("#gifGrid");
  const key = settings.giphy_key;
  if (!key) {
    grid.innerHTML = `<p class="hint">Add your GIPHY API key to settings.json as "giphy_key", then restart Cabtions.</p>`;
    return;
  }
  const q = $("#gifSearch").value.trim();
  const url = q
    ? `https://api.giphy.com/v1/gifs/search?api_key=${encodeURIComponent(key)}&q=${encodeURIComponent(q)}&limit=30&rating=pg-13`
    : `https://api.giphy.com/v1/gifs/trending?api_key=${encodeURIComponent(key)}&limit=30&rating=pg-13`;
  grid.innerHTML = `<p class="hint">Searching…</p>`;
  const seq = ++gifSeq;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`GIPHY said ${res.status}`);
    const data = (await res.json()).data || [];
    if (seq !== gifSeq) return;
    if (!data.length) { grid.innerHTML = `<p class="hint">Nothing for “${esc(q)}”.</p>`; return; }
    grid.innerHTML = data.map((g, i) => {
      const prev = g.images.fixed_height_small || g.images.fixed_height;
      return `<button class="gif-item" data-i="${i}" title="${esc(g.title || "")}"><img src="${esc(prev.url)}" loading="lazy" alt=""></button>`;
    }).join("");
    grid.querySelectorAll(".gif-item").forEach((b) => b.addEventListener("click", () => {
      const g = data[+b.dataset.i];
      insertGifLink((g.images.downsized_medium || g.images.original).url.split("?")[0]);
    }));
  } catch (e) {
    if (seq === gifSeq) grid.innerHTML = `<p class="error">GIF search failed: ${esc(e.message)}</p>`;
  }
}

function insertGifLink(link) {
  if (!gifTarget) return;
  gifTarget.value = (gifTarget.value.trim() + " " + link).trim();
  gifTarget.dispatchEvent(new Event("change", { bubbles: true })); // reuses the notes field's undo push
  closeGifPicker();
}

function closeGifPicker() {
  $("#gifPop").classList.add("hidden");
  gifTarget = null;
}

document.addEventListener("mousedown", (e) => {
  if (!$("#gifPop").classList.contains("hidden") && !e.target.closest("#gifPop, .gif-btn")) closeGifPicker();
});

$("#gifSearch").addEventListener("input", () => { clearTimeout(gifTimer); gifTimer = setTimeout(searchGifs, 350); });
$("#gifModalClose").addEventListener("click", closeGifPicker);
$("#gifSearch").addEventListener("keydown", (e) => { if (e.key === "Escape") closeGifPicker(); });

// Shows a floating window just under (or above) the rect it belongs to, kept on screen.
function placePop(pop, r) {
  pop.classList.remove("hidden");
  pop.style.left = clamp(r.right - pop.offsetWidth, 8, window.innerWidth - pop.offsetWidth - 8) + "px";
  pop.style.top = (r.bottom + pop.offsetHeight + 8 < window.innerHeight ? r.bottom + 6 : Math.max(8, r.top - pop.offsetHeight - 6)) + "px";
}

// ---------- FX presets ----------
// Each preset is only PROD NOTES wording that the renderer (caption_fx.py) already understands, so a preset
// can be edited by hand afterwards like any note. "Used before" are notes from past clips.
const FX_PRESETS = [
  ["Used before", [
    ["Echo", "echoy text moving effect"], ["Big + shaky", "make this text big and shaky"],
    ["Spooky", "spooky shake, purple, echo"], ["Rage", "red, angry violent growing shake"],
    ["Rage build", "red, angry shaking, progressively more violent"], ["MAX RAGE", "red, maximum shake and zoom"],
    ["Sad", "blue, gentle shaking sad text"], ["Nervous", "gentle grow and vibrate"],
    ["Holy", "holy light shine, brief and dramatic"], ["Neon", "glowing green neon"],
    ["Clone army", "multiplying text that gradually turns red and shakes intensely"], ["Little dance", "little subtle dance"],
  ]],
  ["Sly / quiet", [
    ["Sly", "sly lean, slow slide, purple"], ["Sneaky", "sneaky lean, fade in, slide"],
    ["Sarcastic", "sarcastic lean, yellow"], ["Whisper", "whisper fade in, gentle vibrate"],
    ["Ghost", "white, fade in, echo"], ["Drunk", "slow wiggle, echo, lean"],
  ]],
  ["Medieval", [
    ["Medieval", "medieval font"], ["Royal decree", "medieval font, yellow, holy glow"],
    ["Dark lord", "medieval font, red, slow grow, gentle shake"],
  ]],
  ["Punch / mood", [
    ["Impact", "impact"], ["Slam", "slam, hard"], ["Hype", "yellow, very bounce, zoom"],
    ["Panic", "orange, violent vibrate"], ["Cursed", "purple, echo, vibrate"], ["Toxic", "green, wiggle, glow"],
    ["Frozen", "cyan, gentle vibrate, slow grow"], ["Love", "pink, gentle grow, glow"], ["Groove", "pink groove"],
  ]],
];

let fxTarget = null;

$("#fxGrid").innerHTML = FX_PRESETS.map(([group, items]) => `<div class="fx-group">${esc(group)}</div>` +
  items.map(([name, note]) => `<button class="fx-item" data-note="${esc(note)}" title="${esc(note)}">${esc(name)}</button>`).join("")).join("");

function openFxPicker(notesInput, anchor) {
  fxTarget = notesInput;
  placePop($("#fxPop"), anchor.getBoundingClientRect());
}

function closeFxPicker() {
  $("#fxPop").classList.add("hidden");
  fxTarget = null;
}

$("#fxGrid").addEventListener("click", (e) => {
  const b = e.target.closest(".fx-item");
  if (!b || !fxTarget) return;
  const cur = fxTarget.value.trim();
  fxTarget.value = cur ? `${cur}, ${b.dataset.note}` : b.dataset.note;
  fxTarget.dispatchEvent(new Event("change", { bubbles: true })); // a row's notes field pushes its own undo
  closeFxPicker();
});
$("#fxModalClose").addEventListener("click", closeFxPicker);

// ---------- timeline right-click menu + quick edit ----------
function openTlMenu(e, items) {
  e.preventDefault();
  hideBlockTip();
  const m = $("#tlMenu");
  m.innerHTML = "";
  for (const [label, fn] of items) {
    const it = document.createElement("div");
    it.className = "menu-item";
    it.textContent = label;
    it.addEventListener("click", () => { closeTlMenu(); fn(); });
    m.appendChild(it);
  }
  m.classList.remove("hidden");
  m.style.left = clamp(e.clientX, 8, window.innerWidth - m.offsetWidth - 8) + "px";
  m.style.top = clamp(e.clientY, 8, window.innerHeight - m.offsetHeight - 8) + "px";
}

const closeTlMenu = () => $("#tlMenu").classList.add("hidden");

function blockMenu(e, id) {
  const card = cardById(id);
  const ids = state.selection.has(id) ? [...state.selection] : [id];
  openTlMenu(e, [
    ["✎ Quick edit", () => openQuickEdit(card)],
    ["FX preset…", () => { openQuickEdit(card); openFxPicker($("#qeNotes"), $("#qeFxBtn")); }],
    ["+ Add caption after", () => openQuickEdit(insertCardAfter(id, false))],
    ["▶ Jump here", () => { video().currentTime = card.start; }],
    [ids.length > 1 ? `✕ Delete ${ids.length} captions` : "✕ Delete", () => deleteCards(ids)],
  ]);
}

let qeCard = null;

function openQuickEdit(card) {
  qeCard = card;
  $("#qeTitle").textContent = `Quick edit · ${fmtTime(card.start)}`;
  $("#qeText").value = cardEditorText(card);
  $("#qeNotes").value = cardNotesText(card);
  const block = $(`.tl-block[data-id="${card._id}"]`);
  placePop($("#quickEdit"), (block || $("#tlScroll")).getBoundingClientRect());
  $("#qeText").focus();
  $("#qeText").select();
}

// Writes through the caption's list row, so undo, the note chip and the timeline block update exactly as typing there would.
function saveQuickEdit() {
  if (!qeCard) return;
  const values = { ".text": $("#qeText").value, ".notes": $("#qeNotes").value };
  const row = rowOf(qeCard._id);
  closeQuickEdit();
  if (!row) return;
  for (const [sel, v] of Object.entries(values)) {
    const el = row.querySelector(sel);
    if (el.value !== v) { el.value = v; el.dispatchEvent(new Event("change")); }
  }
}

function closeQuickEdit() {
  $("#quickEdit").classList.add("hidden");
  qeCard = null;
  blurFocused();
}

$("#quickEdit").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); saveQuickEdit(); } // else Enter also rewinds the video
  else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeQuickEdit(); }
});
$("#qeSave").addEventListener("click", saveQuickEdit);
$("#qeClose").addEventListener("click", closeQuickEdit);
$("#qeFxBtn").addEventListener("click", (e) => openFxPicker($("#qeNotes"), e.currentTarget));

document.addEventListener("mousedown", (e) => {
  if (!$("#tlMenu").classList.contains("hidden") && !e.target.closest("#tlMenu")) closeTlMenu();
  if (!$("#fxPop").classList.contains("hidden") && !e.target.closest("#fxPop, .fx-btn")) closeFxPicker();
  // a click elsewhere keeps what was typed, the same way leaving a list row's box does
  if (qeCard && !e.target.closest("#quickEdit, #fxPop, #tlMenu")) saveQuickEdit();
});

// ---------- getting out of a text box ----------
// The timeline cancels mousedown (for dragging), so clicking it never took focus away from a caption box and
// every hotkey kept typing into it. Any click outside a text box now leaves it; so do Esc, Enter and the button.
document.addEventListener("mousedown", (e) => {
  if (isTypingTarget(document.activeElement) && !isTypingTarget(e.target)
      && !e.target.closest(".modal, .gif-pop, .emoji-picker, #doneTypingBtn")) blurFocused();
}, true);

function updateDoneTyping() {
  $("#doneTypingBtn").classList.toggle("hidden", !isTypingTarget(document.activeElement));
}
document.addEventListener("focusin", updateDoneTyping);
document.addEventListener("focusout", () => setTimeout(updateDoneTyping));
// blur on click, not mousedown: hiding the button mid-click would land the click on whatever slides under it
$("#doneTypingBtn").addEventListener("mousedown", (e) => e.preventDefault());
$("#doneTypingBtn").addEventListener("click", blurFocused);

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
  wave.addEventListener("mousedown", (e) => startRangeSelect(e, wave));
  wave.title = "Drag to select a stretch to trim · click to move the playhead";
  row("Audio", "tl-wave-label", wave);

  // speaker / caption timelines
  state.lanes.forEach((ln, lane) => {
    if (ln.hidden) return; // hidden from view only - its captions still exist and still render
    const track = document.createElement("div");
    track.className = "tl-lane-track";
    track.dataset.lane = lane;
    track.style.width = width + "px";
    track.addEventListener("mousedown", (e) => { if (e.target === track) onTrackMouseDown(e, lane, track); });
    track.addEventListener("dblclick", (e) => {
      if (e.target !== track) return;
      insertCardAtTime((e.clientX - track.getBoundingClientRect().left) / state.pps, lane);
    });
    track.addEventListener("contextmenu", (e) => {
      if (e.target !== track) return;
      const t = (e.clientX - track.getBoundingClientRect().left) / state.pps;
      openTlMenu(e, [
        ["+ Add caption here", () => openQuickEdit(insertCardAtTime(t, lane, false))],
        ["▶ Move playhead here", () => { video().currentTime = t; }],
      ]);
    });
    state.cards.forEach((card) => { if (Math.min(laneOf(card), laneCount() - 1) === lane) track.appendChild(makeBlock(card)); });
    const color = laneColor(ln);
    const label = row(`<span class="dot" style="background:${color};color:${color}"></span>${esc(ln.name)}`,
      lane === state.activeLane ? "active" : "", track);
    label.title = "Click: “+ Add caption” uses this timeline";
    label.addEventListener("click", () => { state.activeLane = lane; renderTimeline(); });
    const hide = document.createElement("button");
    hide.className = "tl-lane-hide";
    hide.textContent = "–";
    hide.title = "Hide this timeline (its captions stay, and still render)";
    hide.addEventListener("click", (e) => { e.stopPropagation(); setLaneHidden(lane, true); });
    label.appendChild(hide);
  });

  const ph = document.createElement("div");
  ph.id = "tlPlayhead";
  ph.className = "tl-playhead";
  content.appendChild(ph);
  scroll.scrollLeft = sl;
  scroll.scrollTop = st;
  placePlayhead();
  drawWaveform();
  drawTrimLayer();
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
  b.addEventListener("mousedown", (e) => { hideBlockTip(); onBlockMouseDown(e, card._id); });
  b.addEventListener("mouseenter", () => { if (!tlDrag && !marquee) showBlockTip(b, card._id); });
  b.addEventListener("mouseleave", hideBlockTip);
  b.addEventListener("contextmenu", (e) => blockMenu(e, card._id));
  b.addEventListener("dblclick", () => openQuickEdit(cardById(card._id)));
  positionBlock(b, card);
  return b;
}

// Hover pop-out with a block's full caption (blocks are often too narrow to show the whole word): above the
// block, or below it when there's no room above.
function showBlockTip(b, id) {
  const card = cardById(id);
  if (!card) return;
  const tip = $("#tlTip");
  const sp = card.speaker ? speakerByName(card.speaker) : null;
  tip.innerHTML = `<b>${esc(card.lines.join(" / ") || "(blank)")}</b>` +
    `<span>${esc(card.speaker || "untagged")} · ${card.start.toFixed(2)}–${card.end.toFixed(2)}s</span>` +
    (card.note ? `<em>📝 ${esc(card.note)}</em>` : "");
  tip.style.setProperty("--c", sp ? sp.color : "#59625d");
  tip.classList.remove("hidden");
  const r = b.getBoundingClientRect();
  const left = clamp(r.left + r.width / 2 - tip.offsetWidth / 2, 6, window.innerWidth - tip.offsetWidth - 6);
  let top = r.top - tip.offsetHeight - 8;
  if (top < 6) top = r.bottom + 8;
  tip.style.left = left + "px";
  tip.style.top = top + "px";
}

function hideBlockTip() {
  $("#tlTip").classList.add("hidden");
}

function positionBlock(b, card) {
  const { bg, fg } = blockColors(card);
  b.style.left = card.start * state.pps + "px";
  b.style.width = Math.max(6, (card.end - card.start) * state.pps) + "px";
  b.style.background = bg;
  b.style.color = fg;
  b.querySelector(".tl-text").textContent = card.lines.join(" / ") + (card.note ? " 📝" : "");
}

function updateBlock(card) {
  const b = $(`.tl-block[data-id="${card._id}"]`);
  if (b) positionBlock(b, card);
}

function laneAtY(clientY) {
  const tracks = [...document.querySelectorAll(".tl-lane-track")];
  for (const t of tracks) {
    if (clientY < t.getBoundingClientRect().bottom) return +t.dataset.lane;
  }
  return tracks.length ? +tracks[tracks.length - 1].dataset.lane : 0;
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
  if (rangeDrag) { updateRangeSelect(e); return; }
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
  if (rangeDrag) { endRangeSelect(e); return; }
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

// -- autosort: every tagged caption onto its speaker's timeline --

$("#autosortBtn").addEventListener("click", () => {
  const before = snapshotLayout();
  let moved = 0;
  state.cards.forEach((c) => {
    if (!c.speaker) return;
    const lane = laneForSpeaker(c.speaker);
    if (laneOf(c) !== lane) { setLane(c, lane); moved++; }
  });
  const btn = $("#autosortBtn");
  btn.textContent = moved ? `⇅ Moved ${moved}` : "⇅ All sorted";
  setTimeout(() => { btn.textContent = "⇅ Autosort"; }, 1500);
  if (!moved && before.lanes.length === laneCount()) return;
  pushLayoutUndo(before);
  markDirty();
  sortCards();
  renderWords();
  renderTimeline();
});

// -- trimming: select a stretch on the Audio row, then ✂ Trim (or Delete) --
// Trims are stretches of video cut out at render time (saved as "trims" in the speakers file). Captions
// keep their original times; the preview just skips the trimmed stretches.

function mergeRanges(ranges) {
  const out = [];
  ranges.map((r) => [...r]).sort((a, b) => a[0] - b[0]).forEach((r) => {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]); else out.push(r);
  });
  return out;
}

function setTrims(next) {
  const before = state.trims.map((r) => [...r]);
  const end = video().duration || Infinity;  // a trim dragged past the end stops at the video's last frame
  const after = mergeRanges(next.map(([a, b]) => [Math.max(0, a), Math.min(b, end)])).filter(([a, b]) => b - a >= 0.05);
  const apply = (t) => { state.trims = t.map((r) => [...r]); state.trimSel = null; renderTimeline(); updateTrimBtn(); };
  apply(after);
  pushUndo({ undo: () => apply(before), redo: () => apply(after) });
  markDirty();
}

function trimSelection() {
  if (!state.trimSel || state.trimSel[1] - state.trimSel[0] < 0.05) return false;
  setTrims([...state.trims, state.trimSel]);
  return true;
}

function updateTrimBtn() {
  const sel = state.trimSel;
  $("#trimBtn").disabled = !sel;
  $("#trimBtn").textContent = sel ? `✂ Trim ${(sel[1] - sel[0]).toFixed(2)}s` : "✂ Trim";
}

$("#trimBtn").addEventListener("click", trimSelection);

const inTrim = (t) => state.trims.find((r) => t >= r[0] && t < r[1]);

let rangeDrag = null;

function startRangeSelect(e, el) {
  if (e.button !== 0) return;
  e.preventDefault();
  const t = clamp((e.clientX - el.getBoundingClientRect().left) / state.pps, 0, timelineSeconds());
  rangeDrag = { el, t0: t, x0: e.clientX, moved: false };
}

function updateRangeSelect(e) {
  const d = rangeDrag;
  if (!d.moved && Math.abs(e.clientX - d.x0) < 4) return;
  d.moved = true;
  const t = clamp((e.clientX - d.el.getBoundingClientRect().left) / state.pps, 0, timelineSeconds());
  const snap = (v) => Math.round(v * FPS) / FPS;
  state.trimSel = [snap(Math.min(d.t0, t)), snap(Math.max(d.t0, t))];
  drawTrimLayer();
  updateTrimBtn();
}

function endRangeSelect(e) {
  const d = rangeDrag;
  rangeDrag = null;
  if (d.moved) return;
  state.trimSel = null; // a plain click: clear the stretch and move the playhead there
  drawTrimLayer();
  updateTrimBtn();
  video().currentTime = d.t0;
  placePlayhead();
}

// hatched trimmed stretches (with ↺ to restore) and the pending selection, over every row
function drawTrimLayer() {
  document.querySelectorAll(".tl-trim, .tl-trimsel").forEach((el) => el.remove());
  const content = tlContent();
  const h = content.scrollHeight;
  state.trims.forEach((r, i) => {
    const el = document.createElement("div");
    el.className = "tl-trim";
    Object.assign(el.style, { left: LABEL_W + r[0] * state.pps + "px", width: Math.max(2, (r[1] - r[0]) * state.pps) + "px", height: h + "px" });
    el.title = `Trimmed ${r[0].toFixed(2)}s – ${r[1].toFixed(2)}s (cut out when rendered)`;
    const undo = document.createElement("button");
    undo.className = "tl-trim-undo";
    undo.textContent = "↺";
    undo.title = "Bring this stretch back";
    undo.addEventListener("mousedown", (e) => e.stopPropagation());
    undo.addEventListener("click", () => setTrims(state.trims.filter((_, k) => k !== i)));
    el.appendChild(undo);
    content.appendChild(el);
  });
  if (state.trimSel) {
    const el = document.createElement("div");
    el.className = "tl-trimsel";
    Object.assign(el.style, { left: LABEL_W + state.trimSel[0] * state.pps + "px", width: (state.trimSel[1] - state.trimSel[0]) * state.pps + "px", height: h + "px" });
    content.appendChild(el);
  }
}

// -- show / hide / add timelines --

function renderLanesMenu() {
  const menu = $("#lanesMenu");
  const items = [];
  state.lanes.forEach((l, i) => {
    const n = state.cards.filter((c) => laneOf(c) === i).length;
    items.push(`<div class="menu-item" data-toggle="${i}" title="${l.hidden ? "Show" : "Hide"} this timeline (captions are kept either way)">
      <span class="check">${l.hidden ? "" : "✓"}</span><span class="dot" style="background:${laneColor(l)}"></span>${esc(l.name)}<span class="meta">${n}${l.hidden ? " · hidden" : ""}</span></div>`);
  });
  state.speakers.filter((s) => !state.lanes.some((l) => l.speaker === s.name)).forEach((s) => {
    items.push(`<div class="menu-item" data-show="${esc(s.name)}" title="Show ${esc(s.name)}'s timeline">
      <span class="check"></span><span class="dot" style="background:${s.color}"></span>${esc(s.name)}<span class="meta">hidden</span></div>`);
  });
  items.push(`<div class="menu-sep"></div><div class="menu-item" data-add="1"><span class="check">+</span>Add new timeline</div>`);
  menu.innerHTML = items.join("");
  menu.querySelectorAll("[data-toggle]").forEach((el) => el.addEventListener("click", () => {
    const i = +el.dataset.toggle;
    setLaneHidden(i, !state.lanes[i].hidden);
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

// Hiding is view-only: the timeline's captions stay put, show in the caption list, and still render.
function setLaneHidden(i, hidden) {
  if (hidden && state.lanes.filter((l) => !l.hidden).length <= 1) return; // keep at least one on screen
  const before = snapshotLayout();
  if (hidden) state.lanes[i].hidden = true; else delete state.lanes[i].hidden;
  if (hidden && state.activeLane === i) state.activeLane = state.lanes.findIndex((l) => !l.hidden);
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
  markDirty(true); // undoing changes what's in memory vs. the saved files, whichever way the stack now looks
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

// The most recently started caption (any timeline). Tagging passes REACTION_LEEWAY so a slightly-late
// keypress still lands; everything else (highlight, preview, seeking) uses the exact time.
function currentCardIndex(t, leeway = 0) {
  let best = -1;
  for (let i = 0; i < state.cards.length; i++) {
    const c = state.cards[i];
    if (c.start > t + leeway) break;
    if (best < 0 || c.start > state.cards[best].start) best = i;
  }
  return best;
}

function currentCardInLane(t, lane) {
  let best = null;
  for (const c of state.cards) {
    if (c.start > t + 0.001) break;
    if (laneOf(c) === lane) best = c;
  }
  return best;
}

// Tag captions with a speaker and move them onto that speaker's timeline (unhiding it on first use).
function assignSpeaker(name) {
  const targets = state.selection.size > 0
    ? [...state.selection].map(cardById).filter(Boolean)
    : (() => { const i = currentCardIndex(video().currentTime, REACTION_LEEWAY); return i < 0 ? [] : [state.cards[i]]; })();
  const todo = targets.filter((c) => c.speaker !== name || state.lanes[laneOf(c)]?.speaker !== name);
  if (todo.length) {
    const before = snapshotLayout();
    const lane = laneForSpeaker(name);
    delete state.lanes[lane].hidden;
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

// Only real text entry swallows hotkeys. Sliders, buttons, checkboxes and dropdowns don't - after you click
// one, B/J/Space must still tag and play instead of needing a click back into the caption list.
function isTypingTarget(el) {
  if (!el) return false;
  if (el.isContentEditable || el.tagName === "TEXTAREA") return true;
  return el.tagName === "INPUT" && !["range", "checkbox", "radio", "button", "color"].includes(el.type);
}

document.addEventListener("click", (e) => {
  const el = e.target.closest("button, input[type=range], input[type=checkbox]");
  if (el && !el.closest(".modal")) el.blur(); // a focused button would also catch Space as a click
});
document.addEventListener("change", (e) => { if (e.target.matches("select, input[type=range]")) e.target.blur(); });

const openModal = () => [...document.querySelectorAll(".modal")].find((m) => !m.classList.contains("hidden"));

document.addEventListener("keydown", (e) => {
  if ($("#editor").classList.contains("hidden")) return;
  const modal = openModal();
  if (e.key === "Escape" && modal && modal.id !== "speakerModal") { modal.classList.add("hidden"); blurFocused(); return; }
  if (!modal && isTypingTarget(document.activeElement)
      && (e.key === "Escape" || (e.key === "Enter" && document.activeElement.closest(".word-row")))) {
    e.preventDefault();
    blurFocused(); // leave the box; a row's change handler commits the edit on blur
    return;
  }
  if (isTypingTarget(document.activeElement) || modal) return;

  const v = video();
  if (e.key === " ") { e.preventDefault(); v.paused ? v.play() : v.pause(); return; }
  if (e.key === "<" || e.key === ",") { e.preventDefault(); v.currentTime = Math.max(0, v.currentTime - 5); return; }
  if (e.key === ">" || e.key === ".") { e.preventDefault(); v.currentTime = Math.min(v.duration || Infinity, v.currentTime + 5); return; }
  if (e.key === "Enter") { e.preventDefault(); v.currentTime = 0; return; }
  if (e.key === "Backspace") { e.preventDefault(); if (e.shiftKey) redoLast(); else undoLast(); return; }
  if (e.key === "Delete") {
    e.preventDefault();
    if (state.selection.size) deleteCards([...state.selection]); else trimSelection();
    return;
  }
  if (e.key === "Escape") {
    e.preventDefault();
    clearSelection();
    $("#lanesMenu").classList.add("hidden");
    if (state.trimSel) { state.trimSel = null; drawTrimLayer(); updateTrimBtn(); }
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
  const key = active.map((c) => {
    const sp = c.speaker ? speakerByName(c.speaker) : null;
    return c._id + ":" + c.lines.join("|") + ":" + c.speaker + ":" + (sp ? sp.color + sp.font : "");
  }).join(",") + state.font;
  if (overlay.dataset.key !== key) {
    overlay.dataset.key = key;
    overlay.innerHTML = active.map((c, i) => {
      const sp = c.speaker ? speakerByName(c.speaker) : null;
      return `<div class="ov-line${i ? " ov-sub" : ""}" style="color:${sp ? sp.color : "#fff"};font-family:${esc(cardFontFamily(c))}">${esc(c.lines.join("\n").toUpperCase())}</div>`;
    }).join("");
  }

  updateVoiceOverlay(new Set(active.map((c) => c.speaker).filter(Boolean)));

  const idx = currentCardIndex(t);
  document.querySelectorAll(".word-row.current").forEach((r) => r.classList.remove("current"));
  if (idx < 0 || t > state.cards[idx].end + 0.4) return;
  const row = rowOf(state.cards[idx]._id);
  if (row) {
    row.classList.add("current");
    if (state.followVideo && !video().paused) scrollRowIntoList(state.cards[idx]._id);
  }
}

// "Who's talking" overlay preview: every speaker in this video as a small avatar + name, bottom-left of the
// facecam; the ones with a caption on screen light up in their colour. Mirrors render_captions.py.
function updateVoiceOverlay(activeSpeakers) {
  const el = $("#voiceOverlay");
  if (!state.voiceOverlay) { el.innerHTML = ""; el.dataset.key = ""; return; }
  const present = state.lanes.map((l) => l.speaker).filter((n) => n && state.cards.some((c) => c.speaker === n));
  state.cards.forEach((c) => { if (c.speaker && !present.includes(c.speaker)) present.push(c.speaker); });
  const key = present.join(",") + "|" + [...activeSpeakers].join(",");
  if (el.dataset.key === key) return;
  el.dataset.key = key;
  el.innerHTML = present.map((n) => {
    const sp = speakerByName(n);
    const color = sp ? sp.color : "#9aa4ab";
    const on = activeSpeakers.has(n);
    const av = sp && sp.avatar ? `<img class="vo-av" src="${esc(avatarUrl(sp.avatar))}" alt="">` : `<span class="vo-av">${esc(n[0].toUpperCase())}</span>`;
    return `<div class="vo-row${on ? " on" : ""}" style="--c:${color}">${av}<span class="vo-name">${esc(sp && sp.handle ? "@" + sp.handle : n)}</span></div>`;
  }).join("");
}

$("#voiceToggle").addEventListener("change", (e) => { state.voiceOverlay = e.target.checked; markDirty(); });

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
    const cut = !v.paused && inTrim(v.currentTime);
    if (cut) v.currentTime = Math.min(cut[1], v.duration);
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

$("#saveBtn").addEventListener("click", () => saveProject());

// Returns true once both files are written.
async function saveProject() {
  const strayStar = state.cards.filter((c) => c.lines.some((l) => l.includes("*"))).length;
  if (strayStar > 0 && !confirm(`${strayStar} caption${strayStar > 1 ? "s contain" : " contains"} a lone * that would show in the video. Save anyway?`)) return false;
  // A card with no text but a production note is a supported "silent" note-only card; only a card with
  // neither is pointless.
  const emptyCount = state.cards.filter((c) => !c.lines.join("").trim() && !c.note).length;
  if (emptyCount > 0 && !confirm(`${emptyCount} caption${emptyCount > 1 ? "s have" : " has"} neither text nor a production note, so it won't do anything. Save anyway?`)) return false;
  if (!state.speakersHandle) {
    try {
      state.speakersHandle = await window.showSaveFilePicker({
        suggestedName: state.cardsHandle.name.replace(/\.json$/i, "") + "_speakers.json",
        types: JSON_TYPES,
        startIn: state.cardsHandle,
      });
    } catch (e) {
      if (e.name === "AbortError") return false; // cancelled - keep the edits
      alert("Couldn't create the speakers file: " + e.message);
      return false;
    }
  }
  if (!(await ensureReadWrite(state.speakersHandle))) {
    alert("Write permission for the speakers file was denied.");
    return false;
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
  const sidecar = { font: state.font, speakers: state.speakers, lanes: state.lanes, voice_overlay: state.voiceOverlay };
  if (state.trims.length) sidecar.trims = state.trims;
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
    return false;
  }

  saveSettingsSoon();
  markDirty(false);
  $("#speakersPathLabel").textContent = state.speakersHandle.name;
  $("#speakersPathLabel").classList.add("chosen");
  const btn = $("#saveBtn");
  btn.textContent = "Saved ✓";
  setTimeout(() => { btn.textContent = "Save"; }, 1200);
  return true;
}

// ---------- composite ----------
// Saves, then asks the local server to run the compositor on this clip's folder and shows its progress.

$("#compositeBtn").addEventListener("click", async () => {
  const btn = $("#compositeBtn");
  if (!(await saveProject())) return;
  const file = await state.videoHandle.getFile();
  let res;
  try {
    const r = await fetch("/composite", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ video: file.name, size: file.size }) });
    if (!r.ok) throw new Error("the server is an older version - restart Cabtions from the tray icon");
    res = await r.json();
  } catch (e) {
    alert("Couldn't reach the Cabtions server: " + e.message);
    return;
  }
  if (res.error) { alert(res.error); return; }
  if ("Notification" in window && Notification.permission === "default") Notification.requestPermission();
  btn.textContent = res.ahead ? `Queued (${res.ahead} ahead)` : "Started";
  setTimeout(() => { btn.textContent = "Ready for composite"; }, 2500);
  if (!polling) pollComposite();
});

// The bar under the top bar's buttons; clicking it shows the compositor's output, live.
const bar = $("#compositeProgress");
bar.addEventListener("click", () => { $("#logModal").classList.remove("hidden"); scrollLog(); });
$("#logModalClose").addEventListener("click", () => $("#logModal").classList.add("hidden"));
const scrollLog = () => { const el = $("#logBody"); el.scrollTop = el.scrollHeight; };

// Several clips can be queued (open the next clip and press the button again); they composite one after another
// and each one's finish gets its own notification. seenFinished starts at what was already done when Cabtions
// opened, so reopening it never repeats old notifications.
let polling = false;
let seenFinished = null;

async function pollComposite() {
  polling = true;
  let job;
  try { job = await (await fetch("/composite")).json(); } catch { setTimeout(pollComposite, 3000); return; }
  if (seenFinished === null) seenFinished = job.finished.length ? job.finished[job.finished.length - 1].id : 0;
  for (const f of job.finished.filter((f) => f.id > seenFinished)) {
    notify(f.ok ? `Composited: ${f.name}` : `Composite failed: ${f.name}`, f.ok ? f.last : "Click the bar in Cabtions to see why.");
    seenFinished = f.id;
  }
  const queued = job.queue.length ? ` (+${job.queue.length} queued)` : "";
  const pct = Math.round(job.progress * 100);
  const step = [...job.log].reverse().find((l) => l.startsWith("[step"));
  bar.classList.remove("hidden");
  bar.classList.toggle("failed", !job.running && !job.ok);
  bar.querySelector(".fill").style.width = pct + "%";
  bar.querySelector(".label").textContent = job.running
    ? `${pct}% ${step ? step.replace(/^\[step \d+\/\d+\] /, "") : "starting"}…${queued}`
    : job.ok ? "Composited ✓ (log)" : "Failed (see log)";
  const atBottom = $("#logBody").scrollHeight - $("#logBody").scrollTop - $("#logBody").clientHeight < 40;
  $("#logBody").textContent = job.log.join("\n");
  $("#logTitle").textContent = "Composite: " + (job.folder || "").split(/[\\/]/).pop();
  if (atBottom) scrollLog();
  bar.title = "Show the compositor's output" + (job.queue.length ? "\nQueued: " + job.queue.join(", ") : "");
  if (job.running || job.queue.length) { setTimeout(pollComposite, 1500); return; }
  polling = false;
}

// A Windows notification (the browser's), so a finished render is noticed with Cabtions in the background.
function notify(title, body) {
  if ("Notification" in window && Notification.permission === "granted") {
    const n = new Notification(title, { body, icon: "/assets/icon-192.png" });
    n.onclick = () => { window.focus(); bar.click(); };
  } else if (title.includes("failed")) {
    alert(title + "\n\n" + body);
  }
}

// Reopening Cabtions mid-render picks the bar back up.
fetch("/composite").then((r) => r.json()).then((job) => {
  seenFinished = job.finished.length ? job.finished[job.finished.length - 1].id : 0;
  if (job.running || job.queue.length) pollComposite();
}).catch(() => {});

window.addEventListener("beforeunload", (e) => {
  if (state.dirty) { e.preventDefault(); e.returnValue = ""; }
});
