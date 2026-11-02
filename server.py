"""Cabtions - a tiny local server for the caption editor (stdlib only, no pip install).

All project file access (picking the video, cards.json, speakers.json, and saving back to them) happens
client-side via the browser's File System Access API, which pops the real Windows "Open"/"Save As" dialogs.
This server hands the browser the app's static files, plus a few small helpers:

  GET/POST /settings   app-wide settings (speaker roster, favourite fonts) kept in settings.json next to
                       this file, so they survive closing the editor. settings.json is git-ignored.
  GET /fonts           installed fonts (Windows system + per-user font folders, plus any folders listed in
                       settings.json "font_dirs") as [{family, style, file}]
  GET /fontfile?i=N    the Nth font file from /fonts, so the picker can preview it
  POST /avatar?name=X  saves an uploaded profile picture as avatars/X.png (square, 256 px), returns its path
  GET /avatars/X.png   serves one, for the editor's preview
  POST /composite      {video, size}: finds the clip folder holding that video (under settings.json
                       "clip_roots") and queues settings.json "composite_script" on it; queued clips run
                       one after another in the background (one at a time: they share the GPU encoder).
                       The script runs under settings.json "composite_python" when set (the video-editor
                       venv's python.exe), otherwise under this server's own interpreter.
  GET /composite       the running one's state {running, ok, folder, log, step, progress 0..1}, plus
                       queue (clip names waiting) and finished [{id, name, ok, last}]

Usage: <python> server.py [--port 8765]
Then open http://127.0.0.1:8765 in Chrome or Edge (Firefox/Safari don't support the File System Access API).
"""
import argparse
import json
import mimetypes
import os
import re
import struct
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse

STATIC_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_FILES = {"/": "index.html", "/app.js": "app.js", "/style.css": "style.css",
                "/manifest.webmanifest": "manifest.webmanifest"}
ASSET_DIR = os.path.join(STATIC_DIR, "assets")
SETTINGS = os.path.join(STATIC_DIR, "settings.json")
AVATAR_DIR = os.path.join(STATIC_DIR, "avatars")  # speaker profile pictures for the voice overlay (git-ignored)
FONT_EXT = (".ttf", ".otf", ".ttc")
mimetypes.add_type("application/manifest+json", ".webmanifest")


def font_names(path):
    """(family, style) from a TrueType/OpenType 'name' table (first font of a .ttc), or None."""
    try:
        with open(path, "rb") as f:
            data = f.read()
        off = 0
        if data[:4] == b"ttcf":
            off = struct.unpack(">I", data[12:16])[0]
        num = struct.unpack(">H", data[off + 4:off + 6])[0]
        for i in range(num):
            tag, _, toff, _ = struct.unpack(">4sIII", data[off + 12 + 16 * i:off + 28 + 16 * i])
            if tag != b"name":
                continue
            count, soff = struct.unpack(">HH", data[toff + 2:toff + 6])
            found = {}
            for r in range(count):
                pid, eid, lid, nid, ln, so = struct.unpack(">6H", data[toff + 6 + 12 * r:toff + 18 + 12 * r])
                if nid not in (1, 2, 16, 17):
                    continue
                raw = data[toff + soff + so:toff + soff + so + ln]
                if pid == 3 and lid in (0x409, 0):
                    found[nid] = raw.decode("utf-16-be", "ignore")
                elif pid == 1 and nid not in found:
                    found[nid] = raw.decode("latin-1", "ignore")
            family = found.get(16) or found.get(1)
            return (family, found.get(17) or found.get(2) or "Regular") if family else None
    except (OSError, struct.error, IndexError):
        return None
    return None


def cards_problem(path):
    """Why the compositor couldn't use this captions.json, or None if it's a list of cards."""
    try:
        with open(path, encoding="utf-8") as f:
            cards = json.load(f)
    except (OSError, ValueError) as e:
        return f"couldn't read it ({e})"
    if not isinstance(cards, list):
        return "it isn't a list of caption cards (it may have been overwritten by the speakers file)"
    if not all(isinstance(c, dict) and isinstance(c.get("start"), (int, float)) and isinstance(c.get("end"), (int, float)) for c in cards):
        return "a card has no start or end time"
    return None


def load_settings():
    try:
        with open(SETTINGS, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


_fonts = None


def list_fonts():
    global _fonts
    if _fonts is None:
        dirs = [os.path.join(os.environ.get("WINDIR", ""), "Fonts"),
                os.path.join(os.environ.get("LOCALAPPDATA", ""), "Microsoft", "Windows", "Fonts")]
        dirs += load_settings().get("font_dirs", [])
        seen, out = set(), []
        for d in dirs:
            if not d or not os.path.isdir(d):
                continue
            for name in sorted(os.listdir(d)):
                path = os.path.join(d, name)
                if not name.lower().endswith(FONT_EXT) or path.lower() in seen:
                    continue
                seen.add(path.lower())
                fam = font_names(path)
                if fam:
                    out.append({"family": fam[0], "style": fam[1], "file": path})
        out.sort(key=lambda f: (f["family"].lower(), f["style"] != "Regular", f["style"]))
        _fonts = out
    return _fonts


# Composites run one at a time from a queue; the editor polls GET /composite for progress.
# step is the compositor's current "[step k/N] label" line plus the fraction of it done ("frame a/b" lines).
_job = {"running": False, "ok": None, "folder": None, "log": [], "step": None}
_queue = []       # [(python, script, folder)] waiting
_finished = []    # [{id, name, ok, last}] newest last
_worker = {"alive": False}
_job_lock = threading.Lock()
LOG_KEEP = 200    # lines of compositor output kept for the editor's log window
STEP_RE = re.compile(r"\[step (\d+)/(\d+)\]\s*(.*)")
FRAME_RE = re.compile(r"frame (\d+)/(\d+)")


def find_clip_folder(video_name, size, roots):
    """The folder under one of roots (up to 3 levels down) holding video_name at that byte size, or None.
    The browser only gives the file's name, so the size tells same-named files apart."""
    for root in roots:
        for dirpath, dirs, files in os.walk(root):
            if dirpath[len(root):].count(os.sep) >= 3:
                dirs[:] = []
            if video_name in files and os.path.getsize(os.path.join(dirpath, video_name)) == size:
                return dirpath
    return None


def note_line(line):
    """Record one line of compositor output (caller holds _job_lock): the log window, and the progress the
    line implies. Progress is tracked here rather than re-read from the log because one step prints far more
    than LOG_KEEP lines (ffmpeg, the frame counter), which pushed the "[step k/N]" line out of the window."""
    _job["log"].append(line)
    del _job["log"][:-LOG_KEEP]
    m = STEP_RE.match(line)
    if m:
        _job["step"] = {"k": int(m.group(1)), "n": int(m.group(2)), "label": m.group(3).strip(), "frac": 0.0}
        return
    m = FRAME_RE.match(line)
    if m and _job["step"]:
        _job["step"]["frac"] = min(1.0, int(m.group(1)) / max(1, int(m.group(2))))


def progress(job):
    """0..1: finished steps plus the fraction of the current one; 1.0 once the job succeeded."""
    if job["ok"]:
        return 1.0
    s = job["step"]
    return min(1.0, (s["k"] - 1 + s["frac"]) / s["n"]) if s and s["n"] else 0.0


def composite_worker():
    while True:
        with _job_lock:
            if not _queue:
                _worker["alive"] = False
                _job["running"] = False
                return
            python, script, folder = _queue.pop(0)
            _job.update(running=True, ok=None, folder=folder, log=[], step=None)
        try:
            run_composite(python, script, folder)
        except Exception as e:  # the interpreter or script couldn't be launched: report it instead of wedging the queue
            with _job_lock:
                note_line(f"Couldn't run the compositor ({python}): {e}")
                _job["ok"] = False
        with _job_lock:
            last = next((l for l in reversed(_job["log"]) if l.strip()), "")
            _finished.append({"id": len(_finished) + 1, "name": os.path.basename(folder), "ok": _job["ok"], "last": last})
            del _finished[:-50]


def run_composite(python, script, folder):
    proc = subprocess.Popen([python, script, folder], stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            text=True, encoding="utf-8", errors="replace", env={**os.environ, "PYTHONUTF8": "1", "PYTHONUNBUFFERED": "1"},
                            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    for line in proc.stdout:
        with _job_lock:
            note_line(line.rstrip())
    with _job_lock:
        _job["ok"] = proc.wait() == 0


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def send_bytes(self, body, ctype, status=200):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def send_json(self, obj):
        self.send_bytes(json.dumps(obj).encode("utf-8"), "application/json")

    def do_GET(self):
        url = urlparse(self.path)
        if url.path == "/settings":
            return self.send_json(load_settings())
        if url.path == "/composite":
            with _job_lock:
                state = {**_job, "log": list(_job["log"]), "step": dict(_job["step"]) if _job["step"] else None,
                         "progress": progress(_job), "queue": [os.path.basename(f) for _, _, f in _queue],
                         "finished": _finished[-20:]}
            return self.send_json(state)
        if url.path == "/fonts":
            return self.send_json(list_fonts())
        if url.path == "/fontfile":
            try:
                path = list_fonts()[int(parse_qs(url.query)["i"][0])]["file"]
                with open(path, "rb") as f:
                    data = f.read()
            except (KeyError, ValueError, IndexError, OSError):  # bad index, or the font file has gone
                return self.send_error(404)
            return self.send_bytes(data, "font/otf" if path.lower().endswith(".otf") else "font/ttf")
        if url.path.startswith("/avatars/"):
            # the browser percent-encodes the file name ("Ben%20W.png"), so decode before touching the disk
            path = os.path.normpath(os.path.join(STATIC_DIR, unquote(url.path).lstrip("/")))
            if not path.startswith(AVATAR_DIR + os.sep) or not os.path.isfile(path):
                return self.send_error(404)
            with open(path, "rb") as f:
                return self.send_bytes(f.read(), "image/png")
        if url.path.startswith("/assets/"):
            path = os.path.normpath(os.path.join(STATIC_DIR, unquote(url.path).lstrip("/")))
            if not path.startswith(ASSET_DIR + os.sep) or not os.path.isfile(path):  # no escaping the assets folder
                return self.send_error(404)
        else:
            rel = STATIC_FILES.get(url.path)
            if rel is None:
                return self.send_error(404)
            path = os.path.join(STATIC_DIR, rel)
        with open(path, "rb") as f:
            self.send_bytes(f.read(), mimetypes.guess_type(path)[0] or "application/octet-stream")

    def do_POST(self):
        url = urlparse(self.path)
        if url.path == "/avatar":
            return self.save_avatar(parse_qs(url.query).get("name", [""])[0])
        if url.path == "/composite":
            return self.start_composite()
        if url.path != "/settings":
            return self.send_error(404)
        try:
            data = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
            if not isinstance(data, dict):
                raise ValueError("settings must be an object")
        except ValueError as e:
            return self.send_error(400, str(e))
        old = load_settings()
        if not isinstance(old, dict):  # a hand-edited settings.json that isn't an object
            old = {}
        merged = {**old, **data}  # a partial update never wipes other keys (e.g. giphy_key)
        # an editor window running older code saves its roster without handles/pictures - keep them
        def speakers(d):
            lst = d.get("speakers")
            return [sp for sp in lst if isinstance(sp, dict)] if isinstance(lst, list) else []
        prev = {sp.get("name"): sp for sp in speakers(old)}
        for sp in speakers(merged):
            for k in ("handle", "avatar", "font", "font_file"):
                if k not in sp and k in prev.get(sp.get("name"), {}):
                    sp[k] = prev[sp["name"]][k]
        tmp = SETTINGS + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(merged, f, indent=2)
        os.replace(tmp, SETTINGS)
        self.send_json({"ok": True})

    def start_composite(self):
        try:
            req = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
            video, size = os.path.basename(str(req["video"])), int(req["size"])
        except (ValueError, KeyError, TypeError):
            return self.send_error(400, "video name and size needed")
        cfg = load_settings()
        script, roots = cfg.get("composite_script"), cfg.get("clip_roots") or []
        if not script or not os.path.isfile(script) or not roots:
            return self.send_json({"error": 'Set "composite_script" and "clip_roots" in settings.json first.'})
        # The compositor needs video-editor's dependencies, which only its venv has. This server may be running
        # under plain "python" (the tray launcher falls back to it), so the venv's interpreter is configurable.
        python = cfg.get("composite_python") or sys.executable
        if cfg.get("composite_python") and not os.path.isfile(python):
            return self.send_json({"error": f'"composite_python" in settings.json doesn\'t exist: {python}'})
        folder = find_clip_folder(video, size, roots)
        if not folder:
            return self.send_json({"error": f"Couldn't find {video} under the clip folders in settings.json."})
        if os.path.splitext(video)[0] != os.path.basename(folder) or not os.path.isfile(os.path.join(folder, "captions.json")):
            return self.send_json({"error": "The compositor needs <folder>/<folder>.mp4 next to captions.json."})
        problem = cards_problem(os.path.join(folder, "captions.json"))
        if problem:
            return self.send_json({"error": f"Can't composite {os.path.basename(folder)}: {problem}."})
        with _job_lock:
            if (_job["running"] and _job["folder"] == folder) or any(f == folder for _, _, f in _queue):
                return self.send_json({"error": f"{os.path.basename(folder)} is already compositing or queued."})
            _queue.append((python, script, folder))
            ahead = len(_queue) - 1 + (1 if _job["running"] else 0)
            if not _worker["alive"]:
                _worker["alive"] = True
                threading.Thread(target=composite_worker, daemon=True).start()
        self.send_json({"ok": True, "folder": folder, "ahead": ahead})

    def save_avatar(self, name):
        try:
            n = int(self.headers.get("Content-Length", 0))
        except ValueError:
            n = 0
        if not 0 < n <= 15_000_000:
            return self.send_error(400, "picture missing or too big")
        try:
            path = save_avatar_bytes(name, self.rfile.read(n))
        except (ValueError, OSError) as e:
            return self.send_error(400, str(e))
        self.send_json({"path": path, "url": "/avatars/" + os.path.basename(path)})


def save_avatar_bytes(name, data):
    """Square-crop and save an uploaded picture as avatars/<name>.png; returns the saved path."""
    safe = "".join(ch for ch in name if ch.isalnum() or ch in " _-").strip()
    if not safe:
        raise ValueError("speaker name needed")
    os.makedirs(AVATAR_DIR, exist_ok=True)
    path = os.path.join(AVATAR_DIR, safe + ".png")
    try:
        from PIL import Image  # resize when Pillow is available; otherwise keep the file as sent
        import io
        im = Image.open(io.BytesIO(data)).convert("RGB")
        side = min(im.size)
        im = im.crop(((im.width - side) // 2, (im.height - side) // 2, (im.width + side) // 2, (im.height + side) // 2))
        im.resize((256, 256)).save(path)
    except ImportError:
        with open(path, "wb") as f:
            f.write(data)
    return path


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8765)
    args = ap.parse_args()
    # Windows' SO_REUSEADDR lets a second server bind the same port and silently lose every request to the
    # first one; fail loudly instead.
    ThreadingHTTPServer.allow_reuse_address = False
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"Cabtions running at http://127.0.0.1:{args.port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
