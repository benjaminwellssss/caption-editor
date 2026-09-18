"""Standalone local caption/speaker-editing app — a tiny static file server
(stdlib only, no pip install required). All file access (picking the video,
cards.json, speakers.json, and saving back to them) happens client-side via
the browser's native File System Access API, which pops the real Windows
Explorer "Open"/"Save As" dialogs — this server just hands the browser the
three static files that make up the app.

Usage: <python> server.py [--port 8765]
Then open http://127.0.0.1:8765 in Chrome or Edge (Firefox/Safari don't
support the File System Access API yet).
"""
import argparse
import mimetypes
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

STATIC_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_FILES = {"/": "index.html", "/app.js": "app.js", "/style.css": "style.css"}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def do_GET(self):
        rel = STATIC_FILES.get(self.path)
        if rel is None:
            self.send_error(404)
            return
        path = os.path.join(STATIC_DIR, rel)
        ctype = mimetypes.guess_type(path)[0] or "application/octet-stream"
        with open(path, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8765)
    args = ap.parse_args()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"caption editor running at http://127.0.0.1:{args.port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
