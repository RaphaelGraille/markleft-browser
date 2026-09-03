"""Standalone desktop launcher for MarkLeft Browser.

Wraps server.py's existing Flask app in a native window via pywebview
instead of a browser tab -- server.py itself is untouched; this only adds a
thin launcher around it. Requires requirements-desktop.txt (pywebview),
which server.py's normal browser-based usage does not need.

Run: venv/bin/python3 desktop.py [--port 8420]

Flask runs on a background thread; pywebview's native window/event loop
runs on the main thread, which it requires on macOS (the same class of
constraint any native GUI toolkit has here -- see server.py's git history
for what happens when a GUI event loop ends up anywhere else).

--port matters beyond manual use: "New Window" (server.py's /api/new-window)
launches another copy of this same script on a fresh port to open a second,
fully independent window -- so this needs to actually honor the flag, not
just accept it.
"""
import argparse
import socket
import threading
import time

import webview

import server

DEFAULT_PORT = 8420


def _wait_for_server(port, timeout=10):
    """Block until something is listening on 127.0.0.1:port, or timeout."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            if sock.connect_ex(("127.0.0.1", port)) == 0:
                return True
        time.sleep(0.05)
    return False


def _port_in_use(port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        return sock.connect_ex(("127.0.0.1", port)) == 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    args = parser.parse_args()
    port = args.port

    if _port_in_use(port):
        # Something else (a leftover process, a second launch of this app,
        # server.py left running from CLI use) already owns this port.
        # _wait_for_server below only confirms SOMETHING answers on the
        # port -- it can't tell "my own Flask thread bound it" apart from
        # "an unrelated process already there" -- so silently proceeding
        # would open this window against THAT other process's server
        # instead of our own, with no visible error. Pick a genuinely free
        # port instead of ever risking that.
        port = server._find_free_port()

    server.app.config["REPO_ROOT"] = None  # a fresh window always starts empty
    server.app.config["IS_DESKTOP"] = True

    threading.Thread(
        target=lambda: server.app.run(
            host="127.0.0.1", port=port, debug=False, threaded=True, use_reloader=False
        ),
        daemon=True,
    ).start()

    if not _wait_for_server(port):
        raise RuntimeError(f"server did not start listening on port {port}")

    webview.create_window(
        "MarkLeft Browser",
        f"http://127.0.0.1:{port}/",
        width=1200,
        height=800,
        min_size=(700, 500),
        # pywebview defaults this to False on every backend (it's meant for
        # app-chrome-style windows, not one whose whole point is reading
        # text) -- without it, the native webview itself blocks selection
        # before it ever reaches our page's own JS/CSS.
        text_select=True,
    )
    webview.start()


if __name__ == "__main__":
    main()
