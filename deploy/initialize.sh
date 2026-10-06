#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
if [ ! -f .env ]; then
    cp .env.example .env
    chmod 600 .env
    echo 'Created .env. Set PUBLIC_URL and ADMIN_PASSWORD before starting.'
fi
mkdir -p data
chmod 700 data
# The application image runs as this unprivileged UID.
if [ "$(id -u)" = 0 ]; then
    chown 10001:10001 data
else
    echo 'Set data ownership before Docker startup: sudo chown 10001:10001 data'
fi
