#!/usr/bin/env python3
"""Serve only the synthetic, in-memory demo on loopback. No real app token/data required."""
from __future__ import annotations

import argparse
import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from pydantic import ValidationError

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from clip_factory.demo_loop import simulate_loop
from clip_factory.demo_loop_api import DemoLoopBody

ROOT = Path(__file__).resolve().parents[2] / "clip_factory" / "demo_ui"
FILES = {"/": ("index.html", "text/html; charset=utf-8"), "/app.js": ("app.js", "text/javascript; charset=utf-8"),
         "/styles.css": ("styles.css", "text/css; charset=utf-8")}


class Handler(BaseHTTPRequestHandler):
    def reply(self, status, body, content_type="application/json"):
        data = body if isinstance(body, bytes) else json.dumps(body, allow_nan=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Security-Policy", "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        route = FILES.get(self.path.split("?", 1)[0])
        if route is None:
            self.reply(404, {"error": "Not found"})
            return
        name, content_type = route
        self.reply(200, (ROOT / name).read_bytes(), content_type)

    def do_POST(self):
        if self.path != "/api/demo":
            self.reply(404, {"error": "Not found"})
            return
        expected = f"http://{self.headers.get('Host', '')}"
        if self.headers.get("Origin") not in {None, expected}:
            self.reply(403, {"error": "Same-origin requests only"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length < 0 or length > 16384:
                self.reply(413, {"error": "Request is too large"})
                return
            body = DemoLoopBody.model_validate_json(self.rfile.read(length))
            self.reply(200, simulate_loop({"name": "Demo brand"}, **body.model_dump()))
        except (ValueError, ValidationError):
            self.reply(422, {"error": "Use a supported scenario, metric, integer seed and 1–6 rounds."})


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=4176)
    args = parser.parse_args()
    print(f"Synthetic growth-loop rehearsal: http://127.0.0.1:{args.port}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()
