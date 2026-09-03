# MarkLeft Browser

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A local, read-only markdown viewer: point it at any folder and browse its
`.md` files in a file-tree side panel with tabs, GitHub-style rendering,
and full keyboard navigation. No editing, no accounts, no network calls at
runtime — everything (including syntax highlighting) is bundled and runs
entirely on your machine. Ships as a real double-clickable desktop app for
macOS, Windows, and Linux, or you can run it from source in a browser tab.

## Features

- **File tree** of a folder's `.md` files, with a filter box (fuzzy-matches
  by path) and Expand All / Collapse All buttons.
- **Sort** the tree by name, date modified, date created, or size, either
  direction, via the dropdown above the tree — folders always stay grouped
  before files regardless of criterion. The choice is global and persists
  across restarts. (On Linux, "date created" sorts by modification time
  instead, since most Linux filesystems don't expose a real creation
  timestamp.)
- **Tabs**, VS Code-style: clicking a file opens it as a *preview* tab
  (italic, replaced by the next file you click); double-click a file, or
  click a tab's pin icon, to keep it open permanently. Drag tabs to
  reorder them (the rightmost preview tab is anchored and can't be
  dragged onto). Open tabs and their order persist across restarts,
  namespaced per folder.
- **GitHub-style markdown rendering** with syntax-highlighted code blocks,
  parsed off the main thread so a large file never blocks the UI.
  Relative links between `.md` files open as a new tab in the viewer;
  other relative links (images, PDFs, etc.) are served read-only and open
  in a new browser tab.
- **Text is selectable** — select and copy/paste out of any rendered file,
  in the browser or the desktop app.
- **Auto-refresh**: the tree and any open tab pick up external changes —
  edited, added, removed, or renamed files — within about a second, with
  no manual reload. Paused while the window/tab isn't visible. A file that
  disappears out from under an open tab shows an error there instead of
  stale content, and recovers automatically if it reappears.
- **Switch folders at runtime** by clicking the folder name at the top of
  the sidebar — a native folder-picker dialog on macOS and Windows, or a
  manual path entry (with one-click recent folders) everywhere else or if
  the native dialog fails. It warns you, with the exact file list, if
  switching would close any currently-open tabs. Your choice persists
  across restarts.
- **Resizable, collapsible sidebar**: drag the thin divider on its right
  edge to resize, or click the collapse button to hide it entirely (both
  persist across restarts).
- **New Window** (the small window icon next to the file count) opens a
  fully independent second window on its own port, so two windows can
  browse different folders — or the same one — without affecting each
  other.

### Keyboard shortcuts

Tree navigation works everywhere (browser tab or desktop app):

| Key | Action |
|---|---|
| `↑` / `↓` | Move the sidebar cursor, previewing the file it lands on |
| `→` / `←` | Expand / collapse the folder under the cursor |
| `Enter` | Pin the file under the cursor as a permanent tab |
| `Esc` | Close an open dialog |

These only work in the **desktop app** (never bound in a browser tab,
since browsers reserve some of these themselves) and use whichever key
your OS reports as "Meta" — `Cmd` on macOS, the Windows/Super key on
Windows and Linux (only verified on macOS so far; the Windows/Linux
builds are new and untested on real hardware, and the Windows key in
particular is sometimes reserved by the OS itself for window snapping):

| Shortcut (macOS) | Action |
|---|---|
| `Cmd+N` | Open a new window |
| `Cmd+W` | Close the active tab |
| `Cmd+B` | Show/hide the sidebar |
| `Cmd+←` / `Cmd+→` | Switch to the previous / next tab |

## Installation

### Download the app (recommended)

Grab the latest build for your OS from
**[Releases](../../releases/latest)** — no Python, no setup, just the one
file:

- **macOS**: unzip, then double-click `MarkLeft Browser.app`. First launch
  trips Gatekeeper ("Apple could not verify this app is free of
  malware") since it isn't code-signed — right-click → Open once to
  approve it; macOS won't ask again.
- **Windows**: unzip, then double-click `MarkLeft Browser.exe`. First
  launch trips SmartScreen ("Windows protected your PC") for the same
  reason — click "More info" → "Run anyway".
- **Linux**: unzip, `chmod +x` the binary if it lost its executable bit in
  transit, then run it.

None of these are code-signed (that needs a paid developer account per
platform, not done here) — the warnings above are expected and one-time.

The app always starts with no folder selected; use the folder button to
pick one, and it's remembered for next time in the OS's standard per-user
app-data location: `~/Library/Application Support/MarkLeft Browser/`
(macOS), `%APPDATA%\MarkLeft Browser\` (Windows), or
`~/.local/share/MarkLeft Browser/` (Linux).

### Run from source

For browsing in a regular browser tab instead of the desktop app, or to
modify the code yourself. The only real dependency is Flask, pure Python,
identical on every OS.

1. **Install Python 3.9+**, if you don't already have it:
   - macOS: `brew install python@3.11`, or the
     [python.org installer](https://www.python.org/downloads/).
   - Windows: the [python.org installer](https://www.python.org/downloads/) —
     check "Add Python to PATH" during install.
   - Linux (Debian/Ubuntu): `sudo apt install python3 python3-venv`
     (substitute your distro's package manager otherwise).

2. **Create a virtual environment and install Flask:**
   ```
   python3 -m venv venv
   source venv/bin/activate        # Windows: venv\Scripts\activate
   pip install flask
   ```

3. **Run it:**
   ```
   venv/bin/python3 server.py      # Windows: venv\Scripts\python server.py
   ```
   Opens your browser at `http://127.0.0.1:8420/` automatically, with no
   folder selected — use the folder button to pick one. Flags:
   - `--repo <path>` — folder to browse at startup (default: last folder
     switched to in-app)
   - `--port <n>` — default `8420`
   - `--no-browser` — don't auto-open a browser tab

## Building the desktop app from source

```
pip install -r requirements-desktop.txt   # one-time, adds pywebview + pyinstaller
venv/bin/python3 desktop.py               # dev version: native window, still needs a terminal
./build.sh                                # produces the real double-clickable package in dist/
```
`./build.sh` produces `dist/MarkLeft Browser.app` (macOS),
`dist/MarkLeft Browser.exe` (Windows), or `dist/MarkLeft Browser` (Linux),
depending on which OS you run it on — see `desktop.spec` for the per-OS
branching. On Linux, pywebview's GTK backend needs system packages pip
can't install — see the `apt-get install` line in
`.github/workflows/release.yml` for the exact list.

## Releasing

Pushing a version tag (`git tag v1.0.0 && git push origin v1.0.0`)
triggers `.github/workflows/release.yml`: it builds the desktop app on
all three OSes in parallel via GitHub Actions, zips each one, and
publishes a single GitHub Release with all three attached. Nothing to run
by hand — tagging is the entire release process. GitHub Actions is free
and unlimited for this (standard runners on a public repo cost nothing,
on any OS).

## License

MIT — see [LICENSE](LICENSE).
