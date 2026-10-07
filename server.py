#!/usr/bin/env python3
"""Boyd Wall server (stdlib only): serves the wall UI on :4848 plus /api/wall.

Each data source refreshes on its own background thread, so a slow source (Launch Library 2
can take 30+ s per call) never blocks the others. collect.py's disk cache and TTLs keep
request volume well inside every free tier.
"""
import http.server
import json
import os
import socketserver
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import collect  # noqa: E402

PORT = int(os.environ.get("BOYD_WALL_PORT", collect.CFG.get("port", 4848)))
HOST = os.environ.get("BOYD_WALL_HOST", "127.0.0.1")
LOOPS = {"fleet": 60, "weather": 300, "sports": 120, "spacex": 300}  # how often each part re-checks its cache
_lock = threading.Lock()
_state = {"wall": (collect.cache_read("wall") or {}).get("data") or {}, "runs": {}, "started": time.time()}


def refresh(part):
    try:
        fn = {"spacex": collect.collect_spacex, "sports": collect.collect_sports,
              "weather": collect.collect_weather, "fleet": collect.collect_fleet}[part]
        val = fn()
        with _lock:
            w = dict(_state["wall"])
            w[part] = val
            w["usage"] = collect.collect_usage()
            w["jim"] = collect.jim_notes()
            w["generatedAt"] = collect.iso(collect.now_utc())
            w["timezone"] = collect.CFG["timezone"]
            w["location"] = collect.CFG["location"]
            _state["wall"] = w
            _state["runs"][part] = {"at": time.time(), "ok": True}
        collect.cache_write("wall", {"fetchedAt": time.time(), "data": w})
    except Exception as e:  # noqa: BLE001 - keep serving the last good wall
        print(f"[{time.strftime('%H:%M:%S')}] {part} refresh failed: {e}", file=sys.stderr)
        with _lock:
            _state["runs"][part] = {"at": time.time(), "ok": False, "error": str(e)}


def loop(part, every):
    while True:
        refresh(part)
        wait = every
        if part == "spacex":  # if Launch Library asked us to back off, come back right after the window opens
            until = collect._backoff.get("ll.thespacedevs.com", 0) - time.time()
            sp = _state["wall"].get("spacex") or {}
            missing = any((v or {}).get("state") != "live" for v in (sp.get("status") or {}).values())
            if missing and until > 0:
                wait = min(every, until + 3)
        time.sleep(max(10, wait))


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=os.path.join(HERE, "web"), **kw)

    def log_message(self, fmt, *args):
        pass

    def end_headers(self):
        if self.path.split("?")[0].endswith((".js", ".css", ".html", "/")):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def _json(self, obj, code=200):
        body = json.dumps(obj, separators=(",", ":"), default=str).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path, _, q = self.path.partition("?")
        if path == "/api/wall":
            with _lock:
                return self._json(_state["wall"])
        if path == "/api/health":
            with _lock:
                w = _state["wall"]
                return self._json({"ok": bool(w), "uptime": round(time.time() - _state["started"]), "runs": _state["runs"], "generatedAt": w.get("generatedAt")})
        if path == "/api/refresh":
            parts = [p for p in LOOPS if p in q] or list(LOOPS)
            for p in parts:
                threading.Thread(target=refresh, args=(p,), daemon=True).start()
            return self._json({"ok": True, "refreshing": parts})
        if path in ("/kiosk", "/ambient"):
            self.send_response(302)
            self.send_header("Location", "/?kiosk=1" + ("&mode=ambient" if path == "/ambient" else ""))
            self.end_headers()
            return
        if path.startswith("/img/"):
            fn = os.path.basename(path)
            p = os.path.join(collect.IMG, fn)
            if os.path.isfile(p):
                ext = os.path.splitext(fn)[1].lower()
                ct = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml", ".gif": "image/gif"}.get(ext, "application/octet-stream")
                b = open(p, "rb").read()
                self.send_response(200)
                self.send_header("Content-Type", ct)
                self.send_header("Cache-Control", "max-age=86400")
                self.send_header("Content-Length", str(len(b)))
                self.end_headers()
                self.wfile.write(b)
                return
            self.send_error(404)
            return
        return super().do_GET()


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


if __name__ == "__main__":
    for part, every in LOOPS.items():
        threading.Thread(target=loop, args=(part, every), daemon=True).start()
    print(f"Boyd Wall running at http://{HOST}:{PORT}  (kiosk: /kiosk, ambient: /ambient)", flush=True)
    Server((HOST, PORT), Handler).serve_forever()
