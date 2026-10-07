#!/usr/bin/env python3
"""Export dist/boyd-wall-snapshot.html: one self-contained file (HTML + CSS + JS + fonts + images + data)
that opens offline on any computer. Countdowns keep ticking against the viewer's clock; a banner
makes clear the data is a snapshot.

Usage: python3 export_snapshot.py [--from-server]   (default reads the server's /api/wall, falls back to the cache)
"""
import base64
import datetime as dt
import json
import mimetypes
import os
import re
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(HERE, "web")
CFG = json.load(open(os.path.join(HERE, "config.json")))


def data_uri(path, mime=None):
    mime = mime or mimetypes.guess_type(path)[0] or "application/octet-stream"
    return f"data:{mime};base64," + base64.b64encode(open(path, "rb").read()).decode()


def load_wall():
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{CFG['port']}/api/wall", timeout=10) as r:
            w = json.loads(r.read())
            if w.get("generatedAt"):
                return w, "server"
    except Exception:  # noqa: BLE001
        pass
    sys.path.insert(0, HERE)
    import collect  # noqa: E402
    return collect.collect(), "collector"


def main():
    wall, src = load_wall()
    blob = json.dumps(wall, default=str)
    images = {}
    for p in sorted(set(re.findall(r'"(/img/[0-9a-f]{16}\.[a-z]+)"', blob))):
        fp = os.path.join(HERE, "data", "img", os.path.basename(p))
        if os.path.isfile(fp):
            images[p] = data_uri(fp)
    css = open(os.path.join(WEB, "style.css")).read()
    css = css.replace('url("fonts/SpaceGrotesk.ttf")', 'url("' + data_uri(os.path.join(WEB, "fonts", "SpaceGrotesk.ttf"), "font/ttf") + '")')
    css = css.replace('url("fonts/JetBrainsMono.ttf")', 'url("' + data_uri(os.path.join(WEB, "fonts", "JetBrainsMono.ttf"), "font/ttf") + '")')
    js = open(os.path.join(WEB, "app.js")).read()
    html = open(os.path.join(WEB, "index.html")).read()
    snap = {"takenAt": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "data": wall, "images": images, "source": src}
    snap_js = "window.__WALL_SNAPSHOT__ = " + json.dumps(snap, separators=(",", ":"), default=str).replace("</", "<\\/") + ";"
    html = html.replace('<link rel="stylesheet" href="style.css">', "<style>\n" + css + "\n</style>")
    html = html.replace('<script src="app.js"></script>', "<script>" + snap_js + "</script>\n<script>\n" + js.replace("</script", "<\\/script") + "\n</script>")
    html = html.replace("<title>Boyd Wall · Mission Control</title>", "<title>Boyd Wall · offline snapshot</title>")
    assert 'href="style.css"' not in html and 'src="app.js"' not in html
    os.makedirs(os.path.join(HERE, "dist"), exist_ok=True)
    out = os.path.join(HERE, "dist", "boyd-wall-snapshot.html")
    open(out, "w").write(html)
    print(f"wrote {out} ({os.path.getsize(out) / 1e6:.2f} MB, {len(images)} images inlined, data from {src}, taken {snap['takenAt']})")


if __name__ == "__main__":
    main()
