"""Cabtions - a tiny local server for the caption editor (stdlib only, no pip install).

All project file access (picking the video, cards.json, speakers.json, and saving back to them) happens
client-side via the browser's File System Access API, which pops the real Windows "Open"/"Save As" dialogs.
This server hands the browser the app's static files, plus three small helpers:

  GET/POST /settings   app-wide settings (speaker roster, favourite fonts) kept in settings.json next to
                       this file, so they survive closing the editor. settings.json is git-ignored.
  GET /fonts           installed fonts (Windows system + per-user font folders, plus any folders listed in
                       settings.json "font_dirs") as [{family, style, file}]
  GET /fontfile?i=N    the Nth font file from /fonts, so the picker can preview it
  POST /avatar?name=X  saves an uploaded profile picture as avatars/X.png (square, 256 px), returns its path
  GET /avatars/X.png   serves one, for the editor's preview

Usage: <python> server.py [--port 8765]
Then open http://127.0.0.1:8765 in Chrome or Edge (Firefox/Safari don't support the File System Access API).
"""
import argparse
import json
import mimetypes
import os
import struct
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
