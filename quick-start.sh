#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

if ! command -v npm >/dev/null 2>&1; then
  echo "[ROBIN] npm was not found in PATH."
  echo "[ROBIN] Install Node.js 22+ and try again."
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "[ROBIN] Installing dependencies..."
  npm install
fi

if [ ! -f dist/index.html ] || [ ! -f server-dist/index.js ]; then
  echo "[ROBIN] Building app..."
  npm run build
fi

if [ ! -f .env ]; then
  echo '[ROBIN] .env was not found. Run "npm run setup" if you still need initial configuration.'
fi

echo "[ROBIN] Starting..."
exec npm run start
