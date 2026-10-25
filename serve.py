#!/usr/bin/env python3
"""Run the website on your computer, the same way Vercel serves it:
/leaderboard opens leaderboard.html, unknown pages show 404.html.

    python3 serve.py          # then open http://localhost:8000
    python3 serve.py 8080     # another port
"""
import http.server
import os
import sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "frontend")
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000


class CleanUrls(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def send_head(self):
        path, _, query = self.path.partition("?")
        local = self.translate_path(path)
        if not os.path.exists(local) and os.path.exists(local + ".html"):
            self.path = path + ".html" + ("?" + query if query else "")      # /leaderboard -> /leaderboard.html
        elif not os.path.exists(local):
            self.path = "/404.html"
        return super().send_head()


if __name__ == "__main__":
    print(f"Buzzkill on http://localhost:{PORT}  (Ctrl+C to stop)")
    http.server.ThreadingHTTPServer(("", PORT), CleanUrls).serve_forever()
