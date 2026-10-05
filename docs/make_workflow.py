"""Generate docs/workflow.svg (how a caption pass goes, with its options).

PNG: chrome --headless=new --window-size=1500,1320 --screenshot=docs/workflow.png docs/workflow.svg
"""
import os
from html import escape

W, H = 1500, 1320
FONT = "Segoe UI, Helvetica, Arial, sans-serif"
C = {
    "auto": ("#e8f1ff", "#3b6fd8"),     # done by the pipeline / Claude
    "manual": ("#fff1df", "#e08a1e"),   # done by you in the editor
    "choice": ("#f3e8ff", "#8a4fd6"),
    "out": ("#e5f7ea", "#2f9e57"),
    "start": ("#2b2f3a", "#2b2f3a"),
}
out = []


def box(cx, y, w, lines, kind="auto", h=None):
    fill, stroke = C[kind]
    lh = 19
    h = h or 22 + lh * len(lines)
    r = h / 2 if kind == "out" else 10
    out.append(f'<rect x="{cx - w / 2}" y="{y}" width="{w}" height="{h}" rx="{r}" fill="{fill}" stroke="{stroke}" stroke-width="2"/>')
    ty = y + 11 + lh * 0.8
    for i, ln in enumerate(lines):
        color = "#ffffff" if kind == "start" else ("#1d2330" if i == 0 else "#4a5263")
        out.append(f'<text x="{cx}" y="{ty + i * lh}" text-anchor="middle" font-size="{15 if i == 0 else 13}" '
                   f'font-weight="{700 if i == 0 else 400}" fill="{color}">{escape(ln)}</text>')
    return y + h


def diamond(cx, cy, w, h, lines):
    fill, stroke = C["choice"]
    out.append(f'<polygon points="{cx},{cy - h / 2} {cx + w / 2},{cy} {cx},{cy + h / 2} {cx - w / 2},{cy}" '
               f'fill="{fill}" stroke="{stroke}" stroke-width="2"/>')
    y0 = cy - (len(lines) - 1) * 9 + 5
    for i, ln in enumerate(lines):
        out.append(f'<text x="{cx}" y="{y0 + i * 18}" text-anchor="middle" font-size="{15 if i == 0 else 13}" '
                   f'font-weight="{700 if i == 0 else 400}" fill="#1d2330">{escape(ln)}</text>')
    return cy + h / 2


def line(points, arrow=True, dashed=False):
    d = "M " + " L ".join(f"{x},{y}" for x, y in points)
    dash = ' stroke-dasharray="6 5"' if dashed else ""
    end = ' marker-end="url(#ah)"' if arrow else ""
    out.append(f'<path d="{d}" fill="none" stroke="#6b7385" stroke-width="2"{dash}{end}/>')


def label(x, y, text, rotate=0):
    tr = f' transform="rotate({rotate} {x} {y})"' if rotate else ""
    out.append(f'<text x="{x}" y="{y}"{tr} text-anchor="middle" font-size="13" font-weight="700" fill="#8a4fd6">{escape(text)}</text>')


TX = W / 2
out.append(f'<text x="{TX}" y="40" text-anchor="middle" font-size="26" font-weight="800" fill="#1d2330">Caption Editor: a caption pass, start to finish</text>')
out.append(f'<text x="{TX}" y="64" text-anchor="middle" font-size="14" fill="#4a5263">The video-editor pipeline hands you a clip folder; you fix it here; the pipeline renders what you saved.</text>')

y = box(TX, 86, 470, ["A short's clip folder (from video-editor)",
                      "<clip>.mp4 + captions.json (one word per card) + captions.srt"], "start")
line([(TX, y), (TX, y + 26)])
y = box(TX, y + 28, 470, ["1 · Launch the editor",
                          "desktop shortcut (tray icon) — or  python server.py",
                          "opens http://127.0.0.1:8765 in Chrome or Edge"], "manual")
line([(TX, y), (TX, y + 26)])
load_top = y + 28
y = box(TX, load_top, 470, ["2 · Load",
                            "the video + its captions.json",
                            "+ optional speakers file (speaker colors + caption font)"], "manual")
load_mid = (load_top + y) / 2
line([(TX, y), (TX, y + 26)])
q_cy = y + 28 + 48
q_bot = diamond(TX, q_cy, 330, 96, ["3 · What needs fixing?", "any of these, in any order"])

STEP, CW = 228, 210
xs = [TX + (i - 2.5) * STEP for i in range(6)]
split = q_bot + 28
top = split + 32
line([(TX, q_bot), (TX, split)], arrow=False)
line([(xs[0], split), (xs[-1], split)], arrow=False)
tasks = [
    ["Words", "type in the text box", "| = line break (HECK|YES)", "😀 emoji · Win + .", "+ insert · ✕ delete"],
    ["Speakers", "press a speaker key", "(B Ben, J Jared, …)", "on a word or a selection", "colors come from the list"],
    ["Timing", "drag / resize blocks", "←/→ one frame", "(Shift = ten frames)", "or type start/end"],
    ["Overlapping talk", "🕒+ Timeline adds a lane", "move a card to T2:", "shown smaller, under", "the main caption"],
    ["Effects + images", "amber PROD NOTES field", "fx words, a color,", "an image/GIF link,", "\"every time X is said\""],
    ["Font", "Caption font dropdown", "Bebas Neue (house)", "or 4 heavier faces", "saved in speakers file"],
]
bottoms = []
for x, t in zip(xs, tasks):
    line([(x, split), (x, top - 2)])
    bottoms.append(box(x, top, CW, t, "manual"))
merge = max(bottoms) + 28
for x, b in zip(xs, bottoms):
    line([(x, b), (x, merge)], arrow=False)
line([(xs[0], merge), (xs[-1], merge)], arrow=False)
line([(TX, merge), (TX, merge + 26)])

y = box(TX, merge + 28, 470, ["4 · Save",
                              "writes straight back to the same files",
                              "warns about a card with no text and no note"], "manual")
line([(TX, y), (TX, y + 26)])
r_cy = y + 28 + 48
r_bot = diamond(TX, r_cy, 330, 96, ["5 · Ready to render?", "nothing renders until you say so"])
# NO: keep editing (loop up the left side to step 3)
LX = 30
line([(TX - 165, r_cy), (LX, r_cy), (LX, q_cy), (TX - 167, q_cy)], dashed=True)
label(TX - 200, r_cy - 8, "NO")
label(LX + 16, (q_cy + r_cy) / 2, "not yet: keep editing, save again", rotate=-90)
label(TX + 24, r_bot + 18, "YES")
line([(TX, r_bot), (TX, r_bot + 30)])

y = box(TX, r_bot + 32, 560, ["6 · Ask Claude to render (video-editor repo)",
                              "render_captions.py draws your cards exactly as saved; notes → effects,",
                              "image links are downloaded; ffmpeg lays it over the clip → <clip>_captioned.mp4"])
line([(TX, y), (TX, y + 26)])
p_cy = y + 28 + 48
p_bot = diamond(TX, p_cy, 330, 96, ["7 · Proof the video", "does it look right?"])
# NO: reopen and fix (loop up the right side to step 2)
RX = W - 30
line([(TX + 165, p_cy), (RX, p_cy), (RX, load_mid), (TX + 237, load_mid)], dashed=True)
label(TX + 200, p_cy - 8, "NO")
label(RX - 16, (load_mid + p_cy) / 2, "fix it: reload, edit, save, re-render", rotate=90)
label(TX + 24, p_bot + 18, "YES")
line([(TX, p_bot), (TX, p_bot + 30)])
yend = box(TX, p_bot + 32, 470, ["Post it — with metadata.txt from the clip folder"], "out")

ly0 = H - 50
x0 = 70
for kind, text in [("manual", "you, in the editor"), ("auto", "the video-editor pipeline / Claude"),
                   ("choice", "decision"), ("out", "done")]:
    fill, stroke = C[kind]
    out.append(f'<rect x="{x0}" y="{ly0}" width="34" height="26" rx="{13 if kind == "out" else 5}" fill="{fill}" stroke="{stroke}" stroke-width="2"/>')
    out.append(f'<text x="{x0 + 44}" y="{ly0 + 18}" font-size="14" fill="#1d2330">{escape(text)}</text>')
    x0 += 70 + len(text) * 7.6
assert yend < ly0 - 20, (yend, ly0)

svg = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" font-family="{FONT}">'
       '<defs><marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">'
       '<path d="M0,0 L10,5 L0,10 z" fill="#6b7385"/></marker></defs>'
       f'<rect width="{W}" height="{H}" fill="#ffffff"/>' + "\n".join(out) + "</svg>")
open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "workflow.svg"), "w", encoding="utf-8").write(svg)
print("ok, ends at", yend)
