#!/bin/bash
set -e

DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"

PYTHON_BIN="${PYTHON_BIN:-/home/yuan/.local/share/mise/installs/python/3.11/bin/python3.11}"
if [ ! -x "$PYTHON_BIN" ]; then
  echo "Python 3.11 not found at $PYTHON_BIN (install via: mise install python@3.11)"
  exit 1
fi

echo "Building demucs venv ($("$PYTHON_BIN" -V))..."
"$PYTHON_BIN" -m venv .venv/demucs
source .venv/demucs/bin/activate
pip install --upgrade pip
pip install -r requirements/demucs.txt
deactivate

echo ""
echo "Done. Activate with: source .venv/demucs/bin/activate"
