#!/usr/bin/env python3
"""No-cache static dev server for Mars Front.

`python3 -m http.server` sends only Last-Modified (no Cache-Control), so Chrome
heuristically caches ES modules and serves STALE .js after an edit — which shows
up as bogus errors like:

    Uncaught SyntaxError: The requested module './render-node-detail.js'
    does not provide an export named 'drawNodeIcons'

(the browser loaded a new file that imports from an old, cached one). This
server sends `Cache-Control: no-store` on every response, so a plain reload
always fetches fresh modules — no more Cmd+Shift+R dance.

Usage:
    python3 serve.py            # serves this dir on http://localhost:8765
    python3 serve.py 9000       # custom port
"""
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

    # Quieter log line (path only) — the default is noisy at 60 fps of asset hits.
    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    httpd = ThreadingHTTPServer(('', port), NoCacheHandler)
    print(f"Mars Front dev server (no-cache) → http://localhost:{port}/node-conquest.html")
    print("  add ?procgen=1 for the geography-first map · Ctrl-C to stop")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")


if __name__ == '__main__':
    main()
