"""Static dev server + capture endpoint.

GET  /...                 -> files from the project folder
POST /capture/<name>.png  -> body saved to <capture_dir>/<name>.png

usage: python devserver.py <port> <capture_dir>
"""
import http.server
import os
import sys
import urllib.parse

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8731
CAP = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.getcwd(), "captures")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        if not path.startswith("/capture/"):
            self.send_error(404)
            return
        name = os.path.basename(path[len("/capture/"):]) or "shot.png"
        if not name.lower().endswith(".png"):
            name += ".png"
        n = int(self.headers.get("Content-Length", "0"))
        data = self.rfile.read(n)
        os.makedirs(CAP, exist_ok=True)
        out = os.path.join(CAP, name)
        with open(out, "wb") as f:
            f.write(data)
        body = out.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        pass


http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
