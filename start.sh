#!/usr/bin/env bash
# Verginals-pay launcher (mainnet). Edit the values below if needed, then run: ./start.sh
#
# SECRETS: the RPC user/password stay in VERGE.conf (read by the server); never put them here.
# Everything in this file is non-secret (your public fee address + feature flags), so it is safe
# to commit. Any value can be overridden from the environment, e.g.  VERGINALS_SERVICE_FEE_XVG=3 ./start.sh
set -euo pipefail
cd "$(dirname "$0")"

# HTTP port the Node app listens on (put a reverse proxy / HTTPS in front for the internet).
export PORT="${PORT:-3400}"

# Bind address. Default 127.0.0.1 keeps the app reachable ONLY through the reverse proxy, never
# directly on the public IP. Behind nginx/Caddy, leave this as-is.
export VERGINALS_HOST="${VERGINALS_HOST:-127.0.0.1}"

# We sit behind a reverse proxy that forwards the real client IP, so trust X-Forwarded-For for the
# per-IP rate limit. In nginx add:  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
# Set to 0 ONLY if the app is exposed directly with no proxy (otherwise clients could spoof their IP).
export VERGINALS_TRUST_PROXY="${VERGINALS_TRUST_PROXY:-1}"

# Chain this server operates on. mainnet = your local Verge-Qt node (RPC 20103).
export VERGINALS_NETWORK="${VERGINALS_NETWORK:-mainnet}"

# Surface inscriptions made through THIS server from the job files, before the full txindex
# reaches them. Operator-side convenience; harmless to leave on.
export VERGINALS_SHOW_JOBS="${VERGINALS_SHOW_JOBS:-1}"

# Optional operator fee per inscription, in XVG. Disabled by default (0). Hard-capped at 5 by the
# server. Self-hosters who want a fee can set both of the vars below in their environment.
export VERGINALS_SERVICE_FEE_XVG="${VERGINALS_SERVICE_FEE_XVG:-0}"
# XVG address the fee is paid to (only used when the fee above is > 0).
export VERGINALS_FEE_ADDRESS="${VERGINALS_FEE_ADDRESS:-}"

exec node src/server.js
