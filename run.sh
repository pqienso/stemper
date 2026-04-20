#!/usr/bin/env bash
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"

if [ ! -d "$DIR/.venv/demucs" ]; then
  echo "Demucs venv not found. Run scripts/build_venvs.sh first."
  exit 1
fi

echo "Starting Stemper..."
echo ""
echo "  Backend:  http://localhost:8000"
echo "  Frontend: http://localhost:5173"
echo ""

cleanup() {
  trap - EXIT INT TERM
  echo ""
  echo "Shutting down..."
  for pid in "$BACKEND_PID" "$FRONTEND_PID"; do
    [ -n "$pid" ] && pkill -TERM -P "$pid" 2>/dev/null || true
    [ -n "$pid" ] && kill  -TERM  "$pid" 2>/dev/null || true
  done
  sleep 0.5
  for pid in "$BACKEND_PID" "$FRONTEND_PID"; do
    [ -n "$pid" ] && pkill -KILL -P "$pid" 2>/dev/null || true
    [ -n "$pid" ] && kill  -KILL  "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
  exit 0
}

cd "$DIR/backend"
# Turn on yt-dlp diagnostic output (format selection, signature decode,
# extractor internals) so download failures are debuggable from the terminal.
export STEMPER_YTDLP_VERBOSE=1
"$DIR/.venv/demucs/bin/python" -m uvicorn main:app --host 0.0.0.0 --port 8000 --reload &
BACKEND_PID=$!

# Give uvicorn a moment to bind port 8000 before Vite starts proxying.
sleep 2

cd "$DIR/frontend"
npm run dev &
FRONTEND_PID=$!

trap cleanup INT TERM EXIT

wait
