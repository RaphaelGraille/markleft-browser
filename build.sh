#!/bin/bash
# Builds the MarkLeft Browser desktop app via PyInstaller. Produces a
# platform-native package for whichever OS this runs on -- see desktop.spec
# for the exact per-OS output (macOS .app / Windows .exe / Linux binary).
#
# Activate the venv that has requirements-desktop.txt installed first (see
# README.md) -- this just calls `pyinstaller` from whatever's on PATH.
set -euo pipefail
cd "$(dirname "$0")"

pyinstaller desktop.spec --noconfirm

echo
echo "Built: dist/MarkLeft Browser (see dist/ for the exact file for this OS)"
