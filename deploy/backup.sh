#!/bin/sh
# Stop the single application worker to capture SQLite and media consistently.
set -eu
cd "$(dirname "$0")/.."
mkdir -p backups
chmod 700 backups
umask 077
archive="backups/videoedit-$(date -u +%Y%m%d-%H%M%S).tar.gz"
docker compose stop app
trap 'docker compose start app >/dev/null' EXIT INT TERM
tar -czf "$archive" .env data
printf 'Backup saved to %s\n' "$archive"
