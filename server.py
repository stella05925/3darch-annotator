"""Prototype annotation server: serves the web app, the scenes, and stores saved versions and logs.

Standard library only. Scenes come from annotator/data/ (read only), looked up on every request, so new ones appear
without a restart:

    data/annotations/<scene>.json   one scene per file (our annotation format); <scene> = <house id>[_<anything>]
    data/scans/<house>.glb          the textured scan of a Matterport house (tools/make_scan.py makes one)
    data/scenes.json                optional labels: {"<scene>": "Hotel suite · hand-annotated", ...}

Everything the tool writes goes to <out>/<scene>/ (saves/ and logs/), by default outputs/annotator/ next to annotator/.

    ~/miniforge3/envs/viewer/bin/python annotator/server.py            # http://127.0.0.1:8770/
    python3 server.py --port 8017 [--host 127.0.0.1] [--out DIR] [--base /3darch-annotator]

Behind a reverse proxy at a sub-path (aspis.cs.sfu.ca/3darch-annotator/ -> localhost:8017) the app uses only relative
URLs; --base strips that prefix when the proxy passes it on. Access key (optional): set ANNOTATOR_KEY (or --key);
then only browsers that opened the page once as .../?key=<key> (remembered in a cookie) get in.
"""
import argparse
import os
import datetime
import hmac
import json
import re
import shutil
import threading
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qsl, urlencode

ROOT = Path(__file__).resolve().parent
PROJECT = ROOT.parent
DATA = ROOT / "data"
OUT = PROJECT / "outputs" / "annotator"
TOOL_VERSION = "0.3.0"
HOUSE = re.compile(r"^[A-Za-z0-9]{11}")       # Matterport house ids are 11 characters


def scenes():
    """{scene id: {label, house, annotation, scan}} from data/annotations/*.json (read on every call)."""
    labels = {}
    try:
        labels = json.loads((DATA / "scenes.json").read_text())
    except (OSError, ValueError):
        pass
    out = {}
    for p in sorted((DATA / "annotations").glob("*.json")):
        key = p.stem
        m = HOUSE.match(key)
        if not NAME.match(key) or not m:
            continue
        house = m.group(0)
        out[key] = {"label": labels.get(key) or key.replace("_", " · ", 1), "house": house, "annotation": p,
                    "scan": DATA / "scans" / f"{house}.glb"}
    return out


NAME = re.compile(r"^[A-Za-z0-9_.-]{1,80}$")
MAX_BODY = 16 * 1024 * 1024    # one request (a save of the largest house is about 3 MB)
MAX_LOG = 64 * 1024 * 1024     # one session's log file
BASE = ""                      # path prefix a reverse proxy may pass on ("/3darch-annotator"); stripped when present
KEY = None                     # access key (None: open)
_lock = threading.Lock()


def scene_dir(scene, sub):
    d = OUT / scene / sub
    d.mkdir(parents=True, exist_ok=True)
    return d


def list_saves(scene):
    d = OUT / scene / "saves"
    if not d.is_dir():
        return []
    out = []
    for p in sorted(d.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True):
        out.append({"name": p.stem, "bytes": p.stat().st_size,
                    "modified": datetime.datetime.fromtimestamp(p.stat().st_mtime).isoformat(timespec="seconds")})
    return out


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(ROOT / "web"), **kw)

    def log_message(self, fmt, *args):  # quieter console: only API calls and errors
        if "/api/" in self.path or (args and str(args[1]).startswith(("4", "5"))):
            super().log_message(fmt, *args)

    def admit(self):
        """Strip the proxy prefix and check the access key. False when the request has been answered already."""
        if not self.path.startswith("/"):         # a proxy that stripped ".../3darch-annotator" from ".../3darch-annotator?x"
            self.path = "/" + self.path
        if BASE and self.path.partition("?")[0] == BASE:   # the folder without its slash: relative URLs need it
            q = self.path.partition("?")[2]
            self.send_response(HTTPStatus.MOVED_PERMANENTLY)
            self.send_header("Location", BASE.rsplit("/", 1)[-1] + "/" + (f"?{q}" if q else ""))
            self.send_header("Content-Length", "0")
            self.end_headers()
            return False
        if BASE and self.path.startswith(BASE + "/"):
            self.path = self.path[len(BASE):]
        if not KEY:
            return True
        cookie = SimpleCookie(self.headers.get("Cookie", ""))
        if "annot_key" in cookie and hmac.compare_digest(cookie["annot_key"].value.encode(), KEY.encode()):
            return True
        path, _, query = self.path.partition("?")
        q = parse_qsl(query, keep_blank_values=True)
        given = dict(q).get("key", "")
        if given and hmac.compare_digest(given.encode(), KEY.encode()):
            # remember it (no Path: the browser scopes the cookie to this app's folder) and drop it from the address
            rest = urlencode([(k, v) for k, v in q if k != "key"])
            self.send_response(HTTPStatus.SEE_OTHER)
            self.send_header("Set-Cookie", f"annot_key={KEY}; HttpOnly; SameSite=Lax; Max-Age=31536000")
            self.send_header("Location", "./" + (f"?{rest}" if rest else ""))
            self.send_header("Content-Length", "0")
            self.end_headers()
            return False
        if path.startswith("/api/"):
            self.send_json({"error": "access key needed"}, HTTPStatus.UNAUTHORIZED)
        else:
            body = (b"<!doctype html><meta charset=utf-8><title>Annotator</title><p>This annotator needs an access key: "
                    b"open the link you were given (it ends in <code>?key=...</code>).")
            self.send_response(HTTPStatus.UNAUTHORIZED)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        return False

    def list_directory(self, path):  # no folder listings
        self.send_error(HTTPStatus.NOT_FOUND)
        return None

    def do_HEAD(self):
        if self.admit():
            super().do_HEAD()

    def end_headers(self):
        if self.path.split("?")[0].endswith((".html", ".js", ".css", "/")):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    # ---------------------------------------------------------------- helpers
    def send_json(self, obj, status=HTTPStatus.OK):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)

    def send_file(self, path, ctype, cache="no-cache"):
        size = path.stat().st_size
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(size))
        self.send_header("Cache-Control", cache)
        self.end_headers()
        with open(path, "rb") as fh:
            shutil.copyfileobj(fh, self.wfile, 1 << 20)

    def read_json(self):
        n = int(self.headers.get("Content-Length", 0))
        if n <= 0 or n > MAX_BODY:
            raise ValueError("bad body size")
        return json.loads(self.rfile.read(n))

    def scene_or_404(self, scene):
        sc = scenes().get(scene)
        if sc is None:
            self.send_json({"error": f"unknown scene {scene}"}, HTTPStatus.NOT_FOUND)
        return sc

    # ---------------------------------------------------------------- GET
    def do_GET(self):
        if not self.admit():
            return
        path, _, query = self.path.partition("?")
        parts = [p for p in path.split("/") if p]
        try:
            if parts[:2] == ["api", "scenes"]:
                return self.send_json({"tool_version": TOOL_VERSION, "scenes": [
                    {"id": k, "label": v["label"], "house": v["house"], "scan": v["scan"].exists(), "saves": list_saves(k)}
                    for k, v in scenes().items()]})
            if parts[:2] == ["api", "doc"] and len(parts) == 3:
                sc = self.scene_or_404(parts[2])
                if sc is None:
                    return
                params = dict(kv.split("=", 1) for kv in query.split("&") if "=" in kv)
                version = params.get("version", "original")
                if version == "original":
                    return self.send_file(sc["annotation"], "application/json")
                if not NAME.match(version):
                    return self.send_json({"error": "bad version"}, HTTPStatus.BAD_REQUEST)
                p = OUT / parts[2] / "saves" / f"{version}.json"
                if not p.exists():
                    return self.send_json({"error": "no such version"}, HTTPStatus.NOT_FOUND)
                return self.send_file(p, "application/json")
            if parts[:1] == ["scan"] and len(parts) == 2 and parts[1].endswith(".glb"):
                sc = self.scene_or_404(parts[1][:-4])
                if sc is None:
                    return
                if not sc["scan"].exists():
                    return self.send_json({"error": f"no scan for house {sc['house']} (data/scans/{sc['house']}.glb)"}, HTTPStatus.NOT_FOUND)
                return self.send_file(sc["scan"], "model/gltf-binary", cache="max-age=86400")
        except (BrokenPipeError, ConnectionResetError):
            return
        return super().do_GET()

    # ---------------------------------------------------------------- POST
    def do_POST(self):
        if not self.admit():
            return
        parts = [p for p in self.path.split("?")[0].split("/") if p]
        try:
            body = self.read_json()
        except (ValueError, json.JSONDecodeError) as e:
            return self.send_json({"error": str(e)}, HTTPStatus.BAD_REQUEST)
        if len(parts) != 3 or parts[0] != "api" or self.scene_or_404(parts[2]) is None:
            return self.send_json({"error": "not found"}, HTTPStatus.NOT_FOUND)
        scene = parts[2]
        annotator = str(body.get("annotator") or "anon")
        annotator = re.sub(r"[^A-Za-z0-9_-]", "_", annotator)[:40] or "anon"

        if parts[1] == "save":
            doc = body.get("doc")
            if not isinstance(doc, dict):
                return self.send_json({"error": "doc missing"}, HTTPStatus.BAD_REQUEST)
            stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
            name = f"autosave_{annotator}" if body.get("autosave") else f"{stamp}_{annotator}"
            path = scene_dir(scene, "saves") / f"{name}.json"
            kept = None
            with _lock:
                # an autosave left by an earlier browser session (another tab, or a reload that opened the original)
                # is never overwritten: it is kept as an ordinary version first
                if body.get("autosave") and path.exists():
                    try:
                        old = json.loads(path.read_text()).get("annotation_tool", {}).get("session")
                    except (OSError, ValueError):
                        old = None
                    if old != body.get("session"):
                        t = datetime.datetime.fromtimestamp(path.stat().st_mtime).strftime("%Y%m%d-%H%M%S")
                        kept = f"{t}_{annotator}_autosave"
                        path.replace(path.with_name(f"{kept}.json"))
                tmp = path.with_suffix(".tmp")
                tmp.write_text(json.dumps(doc))
                tmp.replace(path)
            return self.send_json({"saved": name, "kept": kept, "saves": list_saves(scene)})

        if parts[1] == "log":
            session = str(body.get("session", ""))
            events = body.get("events")
            if not NAME.match(session) or not isinstance(events, list):
                return self.send_json({"error": "bad log body"}, HTTPStatus.BAD_REQUEST)
            path = scene_dir(scene, "logs") / f"{session}.jsonl"
            if path.exists() and path.stat().st_size > MAX_LOG:
                return self.send_json({"error": "log too large"}, HTTPStatus.REQUEST_ENTITY_TOO_LARGE)
            with _lock, open(path, "a") as fh:
                for ev in events:
                    fh.write(json.dumps(ev, separators=(",", ":")) + "\n")
            return self.send_json({"ok": len(events)})

        return self.send_json({"error": "not found"}, HTTPStatus.NOT_FOUND)


def main():
    global OUT, BASE, KEY
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8770)
    ap.add_argument("--out", type=Path, default=OUT, help="where saves and logs go (default: %(default)s)")
    ap.add_argument("--base", default="", help="URL path prefix the reverse proxy may pass on, e.g. /3darch-annotator")
    ap.add_argument("--key", default=os.environ.get("ANNOTATOR_KEY") or None,
                    help="access key (default: $ANNOTATOR_KEY; none = open to anyone who can reach the port)")
    a = ap.parse_args()
    OUT = a.out.resolve()
    BASE = "/" + a.base.strip("/") if a.base.strip("/") else ""
    KEY = a.key
    if KEY and not re.fullmatch(r"[A-Za-z0-9_-]{8,128}", KEY):
        ap.error("the key must be 8-128 characters of A-Z a-z 0-9 _ -")
    os.umask(0o002)               # saves and logs stay writable for the group (shared /project folder)
    found = scenes()
    missing = sorted({v["house"] for v in found.values() if not v["scan"].exists()})
    print(f"{len(found)} scenes in {DATA / 'annotations'}" + (f"; no scan yet for {', '.join(missing)}" if missing else ""), flush=True)
    srv = ThreadingHTTPServer((a.host, a.port), Handler)
    print(f"annotator {TOOL_VERSION}: http://{a.host}:{a.port}/  (reads {DATA}, writes to {OUT})"
          f"{f', prefix {BASE}' if BASE else ''}, access key {'on' if KEY else 'OFF'}", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
