#!/bin/sh
set -eu
cd "$(dirname "$0")"

if [ ! -f .env ]; then
    echo "Missing .env. Copy .env.example to .env and set ADMIN_PASSWORD." >&2
    exit 1
fi

set -a
. ./.env
set +a

export DATA_DIR="$PWD/data"
export PYTHONPATH=backend
export COOKIE_SECURE="${COOKIE_SECURE:-false}"

if [ ! -x .venv/bin/python ]; then
    echo "Creating Python virtual environment..."
    python3 -m venv .venv
    .venv/bin/python -m pip install -r backend/requirements.txt -c backend/constraints.txt
    .venv/bin/python -m pip install -r backend/requirements-dev.txt
fi

if [ ! -d frontend/node_modules ]; then
    echo "Installing frontend dependencies..."
    npm --prefix frontend ci
fi

mkdir -p "$DATA_DIR"
chmod 700 "$DATA_DIR"

.venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8000 &
BACKEND=$!
npm --prefix frontend run dev &
FRONTEND=$!

cleanup() {
    kill "$BACKEND" "$FRONTEND" 2>/dev/null || true
    wait "$BACKEND" "$FRONTEND" 2>/dev/null || true
}
trap cleanup INT TERM EXIT

printf '\n  VideoEdit: http://127.0.0.1:5173\n  Login: %s\n\n' "${ADMIN_USERNAME:-admin}"

wait
