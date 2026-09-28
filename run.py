#!/usr/bin/env python3
"""Run the bullet vs. water balloon simulation (Windows, Linux, macOS).

Serves this folder on http://127.0.0.1 and opens water_balloon.html in the
default browser. Needs only Python 3.7 or newer.

    python3 run.py [--port N] [--no-browser]

On Windows you can double-click run.bat instead; on Linux run ./run.sh.
"""
import sys

if sys.version_info < (3, 7):
    sys.exit("Python 3.7 or newer is needed (found %d.%d)." % sys.version_info[:2])

import argparse
import hashlib
import http.server
import os
import socket
import urllib.request
import webbrowser

ROOT = os.path.dirname(os.path.abspath(__file__))
PAGE = "water_balloon.html"
TAG = hashlib.sha1(ROOT.encode("utf-8")).hexdigest()[:12]   # marks a server started from this folder


class Handler(http.server.SimpleHTTPRequestHandler):
    # explicit types: on Windows the registry can map these to the wrong MIME type
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css",
                      ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml"}

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")                # always load the latest build
        self.send_header("X-Water-Balloon", TAG)
        super().end_headers()

    def log_message(self, fmt, *args):
        pass


class Server(http.server.ThreadingHTTPServer):
    # with SO_REUSEADDR, Windows lets a second server bind a port that is already
    # in use, so there the port is taken exclusively instead
    allow_reuse_address = os.name != "nt"

    def server_bind(self):
        if os.name == "nt" and hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


def already_running(port):
    """True when a server started from this folder already answers on the port."""
    req = urllib.request.Request("http://127.0.0.1:%d/%s" % (port, PAGE), method="HEAD")
    try:
        with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(req, timeout=2) as r:
            return r.headers.get("X-Water-Balloon") == TAG
    except Exception:
        return False


def show(url, label, browser):
    print(label + url, flush=True)
    if browser and not webbrowser.open(url):
        print("Couldn't open a browser: open that address in Chrome, Edge or Firefox.", flush=True)


def main():
    ap = argparse.ArgumentParser(description="Run the bullet vs. water balloon simulation in your browser.")
    ap.add_argument("--port", type=int, default=8731, help="port to use (default 8731; a free one is picked if it is busy)")
    ap.add_argument("--no-browser", action="store_true", help="don't open a browser window")
    args = ap.parse_args()
    if not os.path.isfile(os.path.join(ROOT, PAGE)):
        sys.exit("Can't find %s next to run.py." % PAGE)

    try:
        server = Server(("127.0.0.1", args.port), Handler)
    except OSError:
        if already_running(args.port):                              # started twice: reuse the first one
            show("http://127.0.0.1:%d/%s" % (args.port, PAGE), "Already running at ", not args.no_browser)
            return
        server = Server(("127.0.0.1", 0), Handler)                   # port busy: let the system pick one

    print("Bullet vs. Water Balloon", flush=True)
    show("http://127.0.0.1:%d/%s" % (server.server_address[1], PAGE), "Running at ", not args.no_browser)
    print("Keep this window open while you use it. Press Ctrl+C to stop.", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("Stopped.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
