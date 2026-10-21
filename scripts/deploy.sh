#!/usr/bin/env bash
# Deploys the Worker with Void. Runs the same way on a laptop and as the
# Workers Builds deploy command.
#
# Void's CLI needs Node >= 24.21; `bunx --bun` runs it on Bun instead, which
# both machines have (Workers Builds preinstalls Bun 1.4.3, Node only 24.18).
set -euo pipefail
cd "$(dirname "$0")/.."

# In Workers Builds (WORKERS_CI=1) there is no browser to sign in with, so
# Void must find the build token in the environment. Fail here, plainly,
# rather than halfway through a deploy.
if [ "${WORKERS_CI:-}" = "1" ] && [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  echo "deploy: CLOUDFLARE_API_TOKEN is not set in this build." >&2
  echo "  Add it under Worker ai > Settings > Builds > Build variables and secrets." >&2
  exit 1
fi

exec bunx --bun void deploy --platform cloudflare
