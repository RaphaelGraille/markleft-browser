"""Local, read-only markdown viewer for the Marvatar/ray repo.

Serves a file-tree API + a static single-page frontend. No editing,
no external network calls at runtime (all JS/CSS assets are vendored
under static/vendor/). The browsed root can be changed at runtime from the
UI (click the folder name); the choice persists across restarts.

Usage:
    python3 server.py [--repo <path>] [--port 8420] [--no-browser]
"""
import argparse
import json
import mimetypes
import socket
import subprocess
import sys
import threading
import webbrowser
from pathlib import Path

from flask import Flask, jsonify, send_from_directory, abort, request, send_file

if getattr(sys, "frozen", False):
    # Running inside a PyInstaller bundle: __file__-relative paths don't
    # point at the bundled resources -- sys._MEIPASS does. State also can't
    # live next to the (effectively read-only, reinstallable) app bundle;
    # it belongs in the OS's standard per-user app-support location.
    TOOL_DIR = Path(sys._MEIPASS)
    STATE_DIR = Path.home() / "Library" / "Application Support" / "MarkLeft Browser"
    STATE_DIR.mkdir(parents=True, exist_ok=True)
else:
    TOOL_DIR = Path(__file__).resolve().parent
    STATE_DIR = TOOL_DIR

STATIC_DIR = TOOL_DIR / "static"
DEFAULT_REPO_ROOT = TOOL_DIR.parent / "ray"
STATE_FILE = STATE_DIR / ".md_viewer_state.json"

EXCLUDED_DIR_NAMES = {
    "node_modules", ".git", "cache", "venv", ".venv", "__pycache__",
    "dist", "build", ".next", ".pytest_cache",
}

app = Flask(__name__, static_folder=None)
app.config["REPO_ROOT"] = DEFAULT_REPO_ROOT
# Set True by desktop.py. The frontend uses this to gate desktop-only
# keyboard shortcuts (Cmd+W especially) that must never be attempted in a
# real browser tab -- browsers reserve those combinations themselves, so a
# page trying to intercept them there would either fail or fight the browser.
app.config["IS_DESKTOP"] = False


def _is_excluded(path: Path) -> bool:
    return any(part in EXCLUDED_DIR_NAMES for part in path.parts)


def _load_last_root() -> Path | None:
    if not STATE_FILE.is_file():
        return None
    try:
        data = json.loads(STATE_FILE.read_text())
    except (json.JSONDecodeError, OSError):
        return None
    candidate = Path(data.get("last_root", ""))
    return candidate if candidate.is_dir() else None


def _save_last_root(root: Path) -> None:
    STATE_FILE.write_text(json.dumps({"last_root": str(root)}))


def _build_tree(root: Path, repo_root: Path) -> dict:
    """Recursively build a JSON-serializable tree of directories containing .md files."""
    children = []
    for entry in sorted(root.iterdir(), key=lambda p: (p.is_file(), p.name.lower())):
        if _is_excluded(entry):
            continue
        if entry.is_dir():
            subtree = _build_tree(entry, repo_root)
            if subtree["children"]:
                children.append(subtree)
        elif entry.suffix.lower() == ".md":
            children.append({
                "type": "file",
                "name": entry.name,
                "path": str(entry.relative_to(repo_root)),
            })
    return {
        "type": "dir",
        "name": root.name or str(root),
        "path": str(root.relative_to(repo_root)) if root != repo_root else "",
        "children": children,
    }


def _resolve_within_repo(rel_path: str) -> Path:
    """Resolve a repo-relative path, refusing anything that escapes the repo root."""
    repo_root = app.config["REPO_ROOT"]
    if repo_root is None:
        abort(400, "no root folder selected yet")
    candidate = (repo_root / rel_path).resolve()
    if repo_root not in candidate.parents and candidate != repo_root:
        abort(400, "path escapes repo root")
    if not candidate.is_file():
        abort(404, "file not found")
    return candidate


def _resolve_safe_md(rel_path: str) -> Path:
    candidate = _resolve_within_repo(rel_path)
    if candidate.suffix.lower() != ".md":
        abort(400, "not a markdown file")
    return candidate


@app.get("/api/tree")
def api_tree():
    repo_root = app.config["REPO_ROOT"]
    is_desktop = app.config["IS_DESKTOP"]
    if repo_root is None:
        return jsonify({
            "type": "dir", "name": "", "path": "", "children": [],
            "rootAbsPath": None, "isDesktop": is_desktop,
        })
    tree = _build_tree(repo_root, repo_root)
    tree["rootAbsPath"] = str(repo_root)
    tree["isDesktop"] = is_desktop
    return jsonify(tree)


@app.get("/api/file")
def api_file():
    rel_path = request.args.get("path", "")
    resolved = _resolve_safe_md(rel_path)
    return app.response_class(resolved.read_text(encoding="utf-8"), mimetype="text/plain")


@app.get("/api/asset")
def api_asset():
    """Serve any repo file read-only (images etc. referenced from markdown)."""
    rel_path = request.args.get("path", "")
    resolved = _resolve_within_repo(rel_path)
    mime, _ = mimetypes.guess_type(str(resolved))
    return send_file(resolved, mimetype=mime or "application/octet-stream")


def _reconcile_root_switch(new_root: Path, open_paths: list[str]) -> dict:
    """For each currently-open (old-root-relative) path, decide whether it
    still lives under new_root -- if so, remap it to a new_root-relative
    path; otherwise it's reported as closing."""
    old_root = app.config["REPO_ROOT"]
    surviving_remap = {}
    will_close = []
    for rel in open_paths:
        abs_path = (old_root / rel).resolve()
        try:
            new_rel = abs_path.relative_to(new_root)
        except ValueError:
            will_close.append(rel)
        else:
            surviving_remap[rel] = str(new_rel)
    return {"root": str(new_root), "survivingRemap": surviving_remap, "willClose": will_close}


NATIVE_PICKER_TIMEOUT_S = 90


@app.post("/api/pick-root-native")
def api_pick_root_native():
    """macOS only: open a native folder dialog via osascript. Returns
    {"supported": false} immediately on any other platform, so the frontend
    can skip straight to manual path entry without wasting a round trip.

    Runs in an isolated subprocess with a hard timeout -- deliberately, not
    in-process. An earlier tkinter-based attempt at this hung outright and
    wedged the whole (at the time single-threaded) dev server; a subprocess
    bounds the blast radius (the child gets killed at the timeout) and the
    server also now runs threaded, so even a stuck request here can't block
    anything else. Any failure -- timeout, osascript missing, anything other
    than a clean cancel -- is reported as a plain error; the caller falls
    back to manual entry rather than treating this as fatal.
    """
    if sys.platform != "darwin":
        return jsonify({"supported": False})

    try:
        result = subprocess.run(
            [
                "osascript",
                # "current application" (osascript's own hosting process, the
                # actual owner of the dialog) is what needs focus -- not an
                # unrelated app like Finder.
                "-e", "tell current application to activate",
                "-e", 'POSIX path of (choose folder with prompt "Select the folder to browse")',
            ],
            capture_output=True, text=True, timeout=NATIVE_PICKER_TIMEOUT_S,
        )
    except subprocess.TimeoutExpired:
        abort(500, f"native picker timed out after {NATIVE_PICKER_TIMEOUT_S}s")
    except FileNotFoundError:
        abort(500, "osascript is not available on this system")

    if result.returncode != 0:
        # AppleScript's user-cancellation is error number -128
        # (userCanceledErr) -- locale-independent, unlike matching the
        # English "User canceled." wording.
        if "-128" in result.stderr:
            return jsonify({"supported": True, "cancelled": True})
        abort(500, f"native picker failed: {result.stderr.strip()}")

    chosen = result.stdout.strip()
    if not chosen or not Path(chosen).is_dir():
        abort(500, "selected path is not a directory")
    return jsonify({"supported": True, "root": chosen})


@app.post("/api/pick-root")
def api_pick_root():
    """Preview the effect of switching to newRoot -- does NOT change the
    active root; call /api/set-root to actually commit."""
    body = request.get_json(force=True, silent=True) or {}
    open_paths = body.get("openPaths", [])
    new_root = Path(body.get("newRoot", "")).expanduser().resolve()
    if not new_root.is_dir():
        abort(400, "not a valid directory")
    return jsonify(_reconcile_root_switch(new_root, open_paths))


@app.post("/api/set-root")
def api_set_root():
    """Actually commit a root switch (call after the user confirms)."""
    body = request.get_json(force=True, silent=True) or {}
    new_root = Path(body.get("root", "")).expanduser().resolve()
    if not new_root.is_dir():
        abort(400, "not a valid directory")
    app.config["REPO_ROOT"] = new_root
    _save_last_root(new_root)
    return jsonify({"root": str(new_root)})


def _find_free_port() -> int:
    """Ask the OS for an unused port (a brief TOCTOU window exists before the
    spawned process binds it -- acceptable for a local single-user tool)."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def _spawn_new_instance(port: int) -> None:
    """Launch another copy of whichever entry point is currently running
    (server.py or desktop.py, or the frozen app binary) on a fresh port.
    Each window is a fully independent process -- no shared root/state to
    coordinate -- reusing that entry point's own existing startup behavior
    (server.py auto-opens a browser tab; desktop.py opens its own native
    window) rather than duplicating that logic here.

    start_new_session=True detaches the child from this process's session,
    so closing THIS window can never take the new one down with it.
    """
    if getattr(sys, "frozen", False):
        cmd = [sys.executable, "--port", str(port)]
    else:
        cmd = [sys.executable, sys.argv[0], "--port", str(port)]
    subprocess.Popen(cmd, cwd=str(TOOL_DIR), start_new_session=True)


@app.post("/api/new-window")
def api_new_window():
    port = _find_free_port()
    try:
        _spawn_new_instance(port)
    except OSError as e:
        abort(500, f"failed to open a new window: {e}")
    return jsonify({"port": port})


@app.get("/")
def index():
    return send_from_directory(STATIC_DIR, "index.html")


@app.get("/static/<path:filename>")
def static_files(filename):
    return send_from_directory(STATIC_DIR, filename)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, default=None,
                         help="Repo root to scan for markdown files "
                              "(default: last folder picked in-app, or ../ray if none yet)")
    parser.add_argument("--port", type=int, default=8420)
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()

    if args.repo is not None:
        chosen_root = args.repo.resolve()
    else:
        chosen_root = _load_last_root() or DEFAULT_REPO_ROOT
    app.config["REPO_ROOT"] = chosen_root

    url = f"http://127.0.0.1:{args.port}/"
    if not args.no_browser:
        threading.Timer(0.7, lambda: webbrowser.open(url)).start()

    print(f"Markdown viewer serving {app.config['REPO_ROOT']} at {url}")
    app.run(host="127.0.0.1", port=args.port, debug=False, threaded=True)


if __name__ == "__main__":
    main()
