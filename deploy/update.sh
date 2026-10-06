#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
git pull --ff-only
docker compose build --pull
docker compose up -d --wait
