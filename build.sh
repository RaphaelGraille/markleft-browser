#!/bin/bash
# Builds MarkLeft Browser.app via PyInstaller.
#
# Activate the venv that has requirements-desktop.txt installed first (see
# README.md) -- this just calls `pyinstaller` from whatever's on PATH.
set -euo pipefail
cd "$(dirname "$0")"

pyinstaller desktop.spec --noconfirm

echo
echo "Built: dist/MarkLeft Browser.app"
