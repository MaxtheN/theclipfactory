"""Open the running interface dev server in a native Mac window.

Run `npm run dev:review` in frontend first. This is a development viewer for
explicit sample data, not a replacement for the authenticated packaged app.
Vite's hot module updates remain active inside the native WKWebView.
"""

from __future__ import annotations

import argparse
import urllib.error
import urllib.parse
import urllib.request


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://127.0.0.1:5178/")
    parser.add_argument("--title", default="Growth Factory — Live Interface")
    args = parser.parse_args()
    url = urllib.parse.urlsplit(args.url)
    if (
        url.scheme != "http"
        or url.hostname not in {"127.0.0.1", "localhost", "::1"}
        or url.username
        or url.password
        or url.query
        or url.fragment
    ):
        parser.error("Use a local HTTP development URL without credentials or query parameters.")
    try:
        with urllib.request.urlopen(args.url, timeout=3) as response:
            if b"Growth Factory" not in response.read(64_000):
                parser.error("This server is not serving the Growth Factory interface.")
    except (OSError, urllib.error.URLError):
        parser.error("Start `npm run dev:review` in frontend, then run this viewer again.")

    import webview

    window = webview.create_window(
        args.title,
        args.url,
        width=1440,
        height=960,
        min_size=(900, 640),
    )

    def ready():
        print("Native Growth Factory interface opened. Vite live updates are active.", flush=True)

    window.events.loaded += ready
    webview.start(private_mode=True)


if __name__ == "__main__":
    main()
