#!/usr/bin/env bash
# Boot dsh web with the ChatHub stack and the OpenAI-wire gateway.
#
# Composition, in order (order matters: the gateway reads the transport health
# the other two layers register):
#   chathub-host    owns the browser, the logins, the per-page turn queue
#   llm-chathub     registers one `<site>-chathub` route per mounted site
#   chathub-gateway opens a second HTTP listener speaking the OpenAI wire
#
# Usage:
#   scripts/run-chathub-gateway.sh                  # headless, gateway :8787
#   DSH_CHATHUB_LOGIN=true scripts/run-chathub-gateway.sh   # visible browser for a first sign-in
#   DSH_CHATHUB_PACING=responsive scripts/run-chathub-gateway.sh
#   DSH_CHATHUB_SMOKE=sse scripts/run-chathub-gateway.sh    # one streaming turn after boot
#
# Every knob below is an environment variable; the defaults keep the gateway
# loopback-only and keyless, which is safe on a single-user machine and wrong
# the moment the bind address leaves 127.0.0.1 (set DSH_CHATHUB_GATEWAY_KEY).
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

# --- knobs -------------------------------------------------------------------
: "${DSH_CHATHUB_SITES:=glm-web,doubao-web,deepseek-web,qianwen-web}"
: "${DSH_CHATHUB_GATEWAY_HOST:=127.0.0.1}"
: "${DSH_CHATHUB_GATEWAY_PORT:=8787}"
: "${DSH_CHATHUB_PACING:=responsive}"
: "${DSH_WEB_PORT:=8899}"
# First run only: a headless Chrome cannot complete a QR sign-in, so the chat
# panel has to be visible. Afterwards the login lives in the Chrome profile.
: "${DSH_CHATHUB_LOGIN:=false}"
# off | plain | sse — one completion request after boot to prove the wire.
: "${DSH_CHATHUB_SMOKE:=off}"
: "${DSH_CHATHUB_LOG:=}"
: "${DSH_CHATHUB_GATEWAY_KEY:=}"
# One site list feeds both layers. They read different variable names, and the
# gateway's own default is "every health-known site" — with only some sites
# mounted that advertises routes that do not exist, so the list is pinned here
# for both.
export DSH_CHATHUB_LLM_SITES="$DSH_CHATHUB_SITES"
export DSH_CHATHUB_GATEWAY_SITES="$DSH_CHATHUB_SITES"
export DSH_CHATHUB_GATEWAY_HOST
export DSH_CHATHUB_GATEWAY_PORT
export DSH_CHATHUB_PACING
export DSH_CHATHUB_GATEWAY_KEY
if [ "$DSH_CHATHUB_LOGIN" = "true" ]; then
  export DSH_CHATHUB_HEADLESS=false
fi

LOG=${DSH_CHATHUB_LOG:-"$ROOT/.dsh-chathub-gateway.log"}
GATEWAY="http://${DSH_CHATHUB_GATEWAY_HOST}:${DSH_CHATHUB_GATEWAY_PORT}"
CURL=(curl -sS --noproxy '*')
# Every request this script makes (boot self-check included) has to carry the
# same key the gateway enforces, or `curl -f` sees 401 forever and the boot
# loop times out even though the server is perfectly healthy. Fold the header
# into CURL itself: expanding an empty "${AUTH[@]}" under `set -u` breaks on
# the bash 3.2 shipped with macOS.
if [ -n "$DSH_CHATHUB_GATEWAY_KEY" ]; then
  CURL+=(-H "authorization: Bearer $DSH_CHATHUB_GATEWAY_KEY")
fi

# --- preflight ---------------------------------------------------------------
command -v node >/dev/null 2>&1 || { echo "run-chathub-gateway: node not on PATH" >&2; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "run-chathub-gateway: curl not on PATH" >&2; exit 1; }
[ -f "$ROOT/apps/cli/src/bin.ts" ] || { echo "run-chathub-gateway: run this from a dsh source checkout ($ROOT has no apps/cli)" >&2; exit 1; }
# NODE_OPTIONS from a host shell can inject loaders the profile does not expect.
unset NODE_OPTIONS

cd "$ROOT"
: > "$LOG"
echo "dsh-chathub-gateway: log $LOG"

# A previous `pnpm dsh web` often survives a closed tab. Detect that before
# boot so EADDRINUSE names the real cause instead of dumping a Node stack.
port_holders() {
  if command -v netstat >/dev/null 2>&1; then
    netstat -ano 2>/dev/null | grep -E "[:.]${1}[[:space:]]" | grep -i listen | head -3
  elif command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$1" -sTCP:LISTEN 2>/dev/null | head -3
  fi
}
port_busy() {
  node -e '
const net = require("node:net");
const port = Number(process.argv[1]);
const socket = net.connect({ host: "127.0.0.1", port });
socket.setTimeout(400);
socket.on("connect", () => { socket.destroy(); process.exit(0) });
socket.on("error", () => process.exit(1));
socket.on("timeout", () => { socket.destroy(); process.exit(1) });
' "$1"
}
port_conflict() {
  echo "run-chathub-gateway: port $1 is already in use; holder:" >&2
  port_holders "$1" >&2
  cat >&2 <<EOF
  Stop the previous dsh web (Ctrl-C in its terminal, or kill that PID), or pick
  free ports, e.g. DSH_CHATHUB_GATEWAY_PORT=8788 DSH_WEB_PORT=8898 $0
EOF
  exit 1
}
port_busy "$DSH_CHATHUB_GATEWAY_PORT" && port_conflict "$DSH_CHATHUB_GATEWAY_PORT"
port_busy "$DSH_WEB_PORT" && port_conflict "$DSH_WEB_PORT"

# Invoke node directly instead of `pnpm dsh`: one process, so the trap below
# actually releases both ports.
node --import tsx/esm "$ROOT/apps/cli/src/bin.ts" web \
  --patch packages/experimental/chathub-host/cordis.patch.yml \
  --patch packages/experimental/llm-chathub/cordis.patch.yml \
  --patch packages/experimental/chathub-gateway/cordis.patch.yml \
  --host 127.0.0.1 --port "$DSH_WEB_PORT" --no-open >> "$LOG" 2>&1 &
DSH_PID=$!

cleanup() {
  if kill -0 "$DSH_PID" 2>/dev/null; then
    kill "$DSH_PID" 2>/dev/null || true
    wait "$DSH_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

# --- wait for the gateway ----------------------------------------------------
models=""
for _ in $(seq 1 60); do
  if ! kill -0 "$DSH_PID" 2>/dev/null; then
    if grep -q EADDRINUSE "$LOG"; then
      port_conflict "$DSH_CHATHUB_GATEWAY_PORT"
    fi
    echo "run-chathub-gateway: dsh exited during boot; last log lines:" >&2
    tail -20 "$LOG" >&2
    exit 1
  fi
  if models=$("${CURL[@]}" -f "$GATEWAY/v1/models" 2>/dev/null); then break; fi
  models=""
  sleep 1
done
if [ -z "$models" ]; then
  echo "run-chathub-gateway: gateway did not answer on $GATEWAY within 60s; log:" >&2
  tail -20 "$LOG" >&2
  exit 1
fi

# --- report ------------------------------------------------------------------
echo "gateway : $GATEWAY/v1"
panel=$(grep -o 'http://127\.0\.0\.1:[0-9]*/?token=[^ ]*' "$LOG" | tail -1 || true)
[ -n "$panel" ] && echo "panel   : $panel"

status=$(printf '%s' "$models" | node -e '
let s = ""
process.stdin.on("data", d => (s += d)).on("end", () => {
  const rows = JSON.parse(s).data
  for (const row of rows) console.log(`  ${row.id.padEnd(14)} ${row.status}`)
  console.log(rows.some(row => row.status === "ready") ? "READY-ANY" : "NONE-READY")
})')
echo "$status" | grep -v 'READY-ANY\|NONE-READY' || true
case "$status" in
  *NONE-READY*)
    cat >&2 <<'EOF'
run-chathub-gateway: health probing never opens a browser, so `needs-auth`
  can also mean a signed-in site whose session has not been opened yet. The
  real sign-in check happens inside the turn; a genuinely signed-out site
  answers 401 chathub_signed_out. Try one turn, e.g.
    DSH_CHATHUB_SMOKE=plain scripts/run-chathub-gateway.sh
  If it does return 401, sign in once with a visible browser:
    DSH_CHATHUB_LOGIN=true scripts/run-chathub-gateway.sh
EOF
    ;;
esac

# --- optional smoke ----------------------------------------------------------
# Deliberately POST to the prefix-less `/chat/completions`: that is the exact
# path WorkBuddy/Cline-style clients build from an endpoint without a trailing
# /v1, and it used to answer 404 "No route". Smoke-testing it keeps the alias
# honest.
if [ "$DSH_CHATHUB_SMOKE" != "off" ]; then
  model=${DSH_CHATHUB_SMOKE_MODEL:-}
  if [ -z "$model" ]; then
    model=$(printf '%s' "$models" | node -e '
let s = ""
process.stdin.on("data", d => (s += d)).on("end", () => {
  const rows = JSON.parse(s).data
  const pick = rows.find(row => row.status === "ready") ?? rows[0]
  if (pick) console.log(pick.id)
})')
  fi
  if [ -z "$model" ]; then
    echo "run-chathub-gateway: smoke skipped, no site exposed" >&2
  else
    body="{\"model\":\"$model\",\"messages\":[{\"role\":\"user\",\"content\":\"Answer with one word: ok\"}]"
    if [ "$DSH_CHATHUB_SMOKE" = "sse" ]; then
      body="$body,\"stream\":true}"
      echo "smoke   : stream $model (POST /chat/completions)"
      "${CURL[@]}" -N -m 180 "$GATEWAY/chat/completions" -H 'content-type: application/json' -d "$body" | head -c 900
    else
      body="$body}"
      echo "smoke   : non-stream $model (POST /chat/completions)"
      "${CURL[@]}" -m 180 -w '\n[HTTP %{http_code}]\n' "$GATEWAY/chat/completions" -H 'content-type: application/json' -d "$body" | head -c 1200
    fi
    echo
  fi
fi

echo "running: dsh web pid $DSH_PID (Ctrl-C to stop, ports $DSH_WEB_PORT and $DSH_CHATHUB_GATEWAY_PORT)"
wait "$DSH_PID"
