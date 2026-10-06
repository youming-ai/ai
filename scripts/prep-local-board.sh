#!/usr/bin/env bash
# Prepares local state for a production-mode render measurement, then reads it.
#
# Why this exists: `astro build` regenerates `dist/server/wrangler.json`, and
# Miniflare names its local D1 file from that config — so every rebuild lands on
# a fresh, empty database and the board renders its empty state. Measurements
# taken without this step compare two different corpora.
#
# Also seeds a deterministic board: 200 published rows across all 8 hubs, each
# pointing at /og.png?i=<n> so the image bytes and count are hermetic (no
# third-party CDN) while still being a wall of images, which is what the board
# actually is. Real feed images are proxied through /media/<uuid> in production.
set -euo pipefail
cd "$(dirname "$0")/.."

CFG=dist/server/wrangler.json
SEED=scripts/perf-seed.sql

if [ ! -f "$CFG" ]; then
  echo "dist/server/wrangler.json missing — run: bun run build" >&2
  exit 1
fi

bunx wrangler d1 migrations apply DB --local --config "$CFG" >/dev/null
bunx wrangler d1 execute DB --local --config "$CFG" --file="$SEED" >/dev/null
bunx wrangler d1 execute DB --local --config "$CFG" \
  --command "SELECT COUNT(*) AS live FROM articles WHERE status='published' AND is_on_topic=1" \
  | grep -o '"live": [0-9]*'
