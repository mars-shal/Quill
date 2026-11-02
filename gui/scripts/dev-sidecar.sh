#!/usr/bin/env bash
#
# Runs the Python sidecar and the Tauri dev window together.
#
# The Rust core already supervises the sidecar: `pipeline_start` spawns
# `.venv/bin/python api.py` on the port `QUILL_API_URL` names, and it starts it
# lazily, the first time the assistant needs it. This script is for the other
# case -- running the sidecar yourself, in your own terminal, with its own logs
# and its own lifetime. That is what you want when the thing being debugged *is*
# the sidecar: a traceback you can read, a process you can attach to, and a
# restart that does not mean restarting the whole app.
#
# The port is the contract between the two processes, so the script decides it
# once, starts the sidecar on it, waits for `/health` to answer, and hands the
# same URL to the Tauri dev server through `QUILL_API_URL`. The two ends cannot
# disagree about where the sidecar is.
#
# Research needs a SearXNG instance, and a missing one is not quiet: the engine
# logs a URLError traceback on every research call before falling back to the
# DuckDuckGo and Bing scrapers. So the script also runs SearXNG, as a Docker
# container it creates, names, and stops again on the way out -- started before
# the sidecar, because the sidecar reads QUILL_SEARXNG_URL from its environment
# when the engine is built, not per call.
#
# The instance is bound to loopback, has no persistent state, and is safe to
# delete at any time. Its settings live in scripts/searxng/settings.yml, which
# turns on the `json` output format -- the one setting whose absence makes every
# search return 403 while looking like flaky research.
#
# Without Docker the script says so and disables the provider explicitly, so the
# log reads `searxng skipped: QUILL_SEARXNG_URL set to empty` instead of a
# connection traceback, and research falls back to the scrapers as designed.
#
# Rust will still try to spawn a sidecar of its own on that port. Its child fails
# to bind and exits, which is harmless and deliberate: `await_ready` checks
# `/health` before it checks the child, so it finds this sidecar answering and
# reports ready. `sidecar::serving`'s own doc calls this out -- a sidecar started
# by hand is a case the supervisor is written to expect.
#
#     bash scripts/dev-sidecar.sh                 # port 8000, then the window
#     bash scripts/dev-sidecar.sh --port 8099     # when 8000 is taken
#     bash scripts/dev-sidecar.sh --sidecar-only  # no window; ctrl-c to stop
#     bash scripts/dev-sidecar.sh --no-search     # no SearXNG; scrapers only
#     bash scripts/dev-sidecar.sh --keep-search   # leave SearXNG running after
#
# ctrl-c stops both. The sidecar is killed on the way out and does not survive
# the window, so the next run starts from a clean port. A SearXNG container the
# script started is stopped too, unless --keep-search was given; one that was
# already running before the script started is never touched.
set -euo pipefail

# Same scrub as scripts/tauri.sh (see the comment there): a snap-packaged
# terminal exports the snap's GDK_PIXBUF_MODULE_FILE etc., and this app's GTK
# stack dies before painting when it loads the snap's GLIBC-2.38 loader on this
# GLIBC-2.35 system. Values already pointing outside /snap are left alone.
for _var in GDK_PIXBUF_MODULE_FILE GDK_PIXBUF_MODULEDIR GIO_MODULE_DIR GTK_PATH LOCPATH; do
  case "${!_var:-}" in /snap/*|*/snap/ghostty/*) unset "$_var" ;; esac
done

# Same filtering as scripts/tauri.sh: a snap-terminal LD_LIBRARY_PATH entry
# makes gdk-pixbuf resolve its loaders from the snap's delegates and die on
# this system's older glibc. Non-snap entries survive the filter.
if [[ "${LD_LIBRARY_PATH:-}" == *"/snap/"* ]]; then
  _clean=""
  IFS=':' read -ra _lps <<< "${LD_LIBRARY_PATH}"
  for _p in "${_lps[@]}"; do
    case "$_p" in /snap/*) ;; *) _clean="${_clean:+$_clean:}$_p" ;; esac
  done
  if [ -n "$_clean" ]; then
    LD_LIBRARY_PATH="$_clean"
    export LD_LIBRARY_PATH
  else
    unset LD_LIBRARY_PATH
  fi
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GUI="$ROOT/gui"

PORT="${SIDECAR_PORT:-8000}"
PYTHON="${QUILL_PIPELINE_PYTHON:-}"
SIDECAR_ONLY=0
GUI_CMD="${GUI_CMD:-bash scripts/tauri.sh dev}"
# The sidecar imports the pipeline modules before it binds, which is not instant.
READY_TIMEOUT="${READY_TIMEOUT:-60}"

# SearXNG. The port is what QUILL_SEARXNG_URL points at, so the sidecar and the
# container cannot end up on different ports. The name is fixed so a second run
# reuses the container instead of piling up copies.
SEARCH=1
KEEP_SEARCH=0
SEARXNG_PORT="${SEARXNG_PORT:-8080}"
SEARXNG_NAME="${SEARXNG_NAME:-quill-searxng}"
SEARXNG_IMAGE="${SEARXNG_IMAGE:-searxng/searxng:latest}"
SEARXNG_SETTINGS="$ROOT/scripts/searxng/settings.yml"
# A container boot is a few seconds; a first-time pull is not. The timeout only
# covers the boot, and the pull says what it is doing rather than looking hung.
SEARXNG_TIMEOUT="${SEARXNG_TIMEOUT:-60}"

usage() {
  sed -n '3,49p' "${BASH_SOURCE[0]}" | sed 's/^#\{1,2\} \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --port)         PORT="${2:?--port needs a value}"; shift 2 ;;
    --python)       PYTHON="${2:?--python needs a value}"; shift 2 ;;
    --gui-cmd)      GUI_CMD="${2:?--gui-cmd needs a value}"; shift 2 ;;
    --searxng-port) SEARXNG_PORT="${2:?--searxng-port needs a value}"; shift 2 ;;
    --no-search)    SEARCH=0; shift ;;
    --keep-search)  KEEP_SEARCH=1; shift ;;
    --sidecar-only) SIDECAR_ONLY=1; shift ;;
    -h|--help)      usage; exit 0 ;;
    *) echo "error: unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

case "$PORT" in
  ''|*[!0-9]*) echo "error: --port must be a number, got '$PORT'" >&2; exit 2 ;;
esac

case "$SEARXNG_PORT" in
  ''|*[!0-9]*) echo "error: --searxng-port must be a number, got '$SEARXNG_PORT'" >&2; exit 2 ;;
esac

if [ ! -f "$ROOT/api.py" ]; then
  echo "error: no api.py at $ROOT" >&2
  echo "  this script expects to live in the repository it starts." >&2
  exit 1
fi

# The interpreter is the one that has the pipeline's dependencies. Rust makes the
# same choice, so a run started here and a run started by the app agree on it.
if [ -z "$PYTHON" ]; then
  if [ -x "$ROOT/.venv/bin/python" ]; then
    PYTHON="$ROOT/.venv/bin/python"
  else
    echo "error: no interpreter found for the sidecar." >&2
    echo "  expected $ROOT/.venv/bin/python" >&2
    echo "  create it:" >&2
    echo "    python3 -m venv \"$ROOT/.venv\"" >&2
    echo "  then install the pipeline's dependencies into it." >&2
    echo "  or name one directly: $0 --python /path/to/python" >&2
    exit 1
  fi
fi

if [ ! -x "$PYTHON" ]; then
  echo "error: the interpreter is not executable: $PYTHON" >&2
  exit 1
fi

# `/health` is the readiness signal Rust itself waits on, so the two agree on
# what "up" means rather than one testing the port and the other the endpoint.
# A bound port is not the same thing as a sidecar that can answer.
health_ok() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsS -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/health" 2>/dev/null
  else
    "$PYTHON" - "$PORT" <<'PY' 2>/dev/null
import sys, urllib.request
try:
    urllib.request.urlopen(f"http://127.0.0.1:{sys.argv[1]}/health", timeout=2)
except Exception:
    sys.exit(1)
PY
  fi
}

# A port already held would make the sidecar fail to bind, and the failure would
# look like the script hanging until its readiness timeout. Say so immediately.
if health_ok; then
  echo "error: a sidecar is already answering on 127.0.0.1:$PORT." >&2
  echo "  stop it, or choose another port:  $0 --port 8099" >&2
  exit 1
fi

SIDECAR_PID=""

# SearXNG, brought up before the sidecar because QUILL_SEARXNG_URL has to be in
# the sidecar's environment when it starts.
#
# Every failure below warns and continues. Research has working scraper
# fallbacks, and refusing to start the whole app because a search helper is
# unavailable would be a much worse trade than starting without it -- but it is
# never silent: a disabled provider is exported as an explicit empty
# QUILL_SEARXNG_URL, which the engine logs as a deliberate opt-out rather than
# firing a connection traceback on every query.
SEARXNG_OWNED=0

searxng_health() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsS -o /dev/null --max-time 2 "http://127.0.0.1:$SEARXNG_PORT/healthz" 2>/dev/null
  else
    "$PYTHON" - "$SEARXNG_PORT" <<'PY' 2>/dev/null
import sys, urllib.request
try:
    urllib.request.urlopen(f"http://127.0.0.1:{sys.argv[1]}/healthz", timeout=2)
except Exception:
    sys.exit(1)
PY
  fi
}

search_off() {
  export QUILL_SEARXNG_URL=""
}

start_searxng() {
  if [ "$SEARCH" -eq 0 ]; then
    echo "==> search: off (--no-search); research uses the scrapers"
    search_off
    return 0
  fi

  # Something already answering is enough, whether this script started it on a
  # previous run or not. Never tear down an instance the script did not start.
  if searxng_health; then
    echo "==> search: reusing the SearXNG on 127.0.0.1:$SEARXNG_PORT"
    export QUILL_SEARXNG_URL="http://127.0.0.1:$SEARXNG_PORT"
    return 0
  fi

  if ! command -v docker >/dev/null 2>&1; then
    echo "==> search: no docker on PATH; research uses the scrapers" >&2
    search_off
    return 0
  fi
  if ! docker ps -q >/dev/null 2>&1; then
    echo "==> search: docker is not reachable; research uses the scrapers" >&2
    search_off
    return 0
  fi
  if [ ! -f "$SEARXNG_SETTINGS" ]; then
    echo "==> search: no settings file at $SEARXNG_SETTINGS; research uses the scrapers" >&2
    search_off
    return 0
  fi

  # A container left behind by an earlier run is reused, but only if it was
  # published on the port this run wants: `docker start` cannot re-map ports, so
  # one created for a different port would boot and answer nowhere. It holds no
  # state, so recreating it costs a boot and nothing else.
  local published
  published="$(docker port "$SEARXNG_NAME" 8080/tcp 2>/dev/null | head -1 | sed 's/.*://' || true)"
  if [ -n "$published" ] && [ "$published" != "$SEARXNG_PORT" ]; then
    echo "==> search: recreating $SEARXNG_NAME for port $SEARXNG_PORT (was $published)"
    docker rm -f "$SEARXNG_NAME" >/dev/null 2>&1 || true
  fi

  if docker container inspect "$SEARXNG_NAME" >/dev/null 2>&1; then
    echo "==> search: starting $SEARXNG_NAME"
    if ! docker start "$SEARXNG_NAME" >/dev/null; then
      echo "==> search: could not start $SEARXNG_NAME; research uses the scrapers" >&2
      search_off
      return 0
    fi
  else
    echo "==> search: creating $SEARXNG_NAME from $SEARXNG_IMAGE"
    if ! docker run -d --name "$SEARXNG_NAME" \
        -p "127.0.0.1:$SEARXNG_PORT:8080" \
        -v "$SEARXNG_SETTINGS:/etc/searxng/settings.yml:ro" \
        "$SEARXNG_IMAGE" >/dev/null; then
      echo "==> search: could not create $SEARXNG_NAME; research uses the scrapers" >&2
      search_off
      return 0
    fi
  fi
  SEARXNG_OWNED=1

  local tries=$((SEARXNG_TIMEOUT * 4)) attempt=0
  while ! searxng_health; do
    if [ "$attempt" -ge "$tries" ]; then
      echo "==> search: $SEARXNG_NAME did not answer on $SEARXNG_PORT within ${SEARXNG_TIMEOUT}s" >&2
      echo "    its log:  docker logs --tail 40 $SEARXNG_NAME" >&2
      search_off
      return 0
    fi
    sleep 0.25
    attempt=$((attempt + 1))
  done

  # `/healthz` proves the server boots; it says nothing about the JSON API being
  # on. A 403 there is the classic misconfiguration -- the engine reports it as
  # "no results" and silently falls through to the scrapers, so it surfaces days
  # later as "research is flaky". One request here names it instead.
  if command -v curl >/dev/null 2>&1; then
    local code
    code="$(curl -s -o /dev/null --max-time 15 -w '%{http_code}' \
      "http://127.0.0.1:$SEARXNG_PORT/search?q=quill+health&format=json&categories=general&language=en" || true)"
    case "$code" in
      200) ;;
      403) echo "==> search: JSON output is disabled (HTTP 403). Add 'json' under search.formats in $SEARXNG_SETTINGS" >&2 ;;
      *)   echo "==> search: the JSON probe answered HTTP $code; research may fall back" >&2 ;;
    esac
  fi

  export QUILL_SEARXNG_URL="http://127.0.0.1:$SEARXNG_PORT"
  echo "==> search: $SEARXNG_NAME on $QUILL_SEARXNG_URL"
}

cleanup() {
  # Runs twice on a signal -- once for INT/TERM, once for the EXIT that follows
  # -- so it has to be idempotent. The flag is cleared as the work is done.
  if [ "$SEARXNG_OWNED" -eq 1 ]; then
    SEARXNG_OWNED=0
    if [ "$KEEP_SEARCH" -eq 1 ]; then
      echo
      echo "==> $SEARXNG_NAME left running (--keep-search)"
    else
      echo
      echo "==> stopping $SEARXNG_NAME"
      docker stop "$SEARXNG_NAME" >/dev/null 2>&1 || true
    fi
  fi
  [ -n "$SIDECAR_PID" ] || return 0
  kill -0 "$SIDECAR_PID" 2>/dev/null || return 0
  echo
  echo "==> stopping the sidecar (pid $SIDECAR_PID)"
  kill "$SIDECAR_PID" 2>/dev/null || true
  # Give it a moment to close its listeners, then insist. A sidecar that ignores
  # SIGTERM would otherwise keep the port and break the next run.
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    kill -0 "$SIDECAR_PID" 2>/dev/null || return 0
    sleep 0.2
  done
  echo "==> the sidecar did not stop; killing it" >&2
  kill -9 "$SIDECAR_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# After the trap, so a container this script creates is always stopped again.
start_searxng

echo "==> sidecar: $PYTHON api.py --host 127.0.0.1 --port $PORT"
# `exec` replaces the subshell, so $! is the interpreter itself and not a wrapper
# that would swallow the signal and leave the real process behind.
( cd "$ROOT" && exec "$PYTHON" api.py --host 127.0.0.1 --port "$PORT" ) &
SIDECAR_PID=$!

tries=$((READY_TIMEOUT * 4))
attempt=0
while ! health_ok; do
  if ! kill -0 "$SIDECAR_PID" 2>/dev/null; then
    echo "error: the sidecar exited before it answered /health." >&2
    echo "  the reason is in the output above." >&2
    exit 1
  fi
  if [ "$attempt" -ge "$tries" ]; then
    echo "error: the sidecar did not answer /health on $PORT within ${READY_TIMEOUT}s." >&2
    exit 1
  fi
  sleep 0.25
  attempt=$((attempt + 1))
done

export QUILL_API_URL="http://127.0.0.1:$PORT"
# Rust spawns with this too, so a sidecar it starts later uses the same
# interpreter rather than falling back to whatever `python3` is on PATH.
export QUILL_PIPELINE_PYTHON="$PYTHON"

if [ "$SIDECAR_ONLY" -eq 1 ]; then
  echo "==> ready on $QUILL_API_URL -- sidecar only, ctrl-c to stop"
  wait "$SIDECAR_PID"
  exit $?
fi

echo "==> ready on $QUILL_API_URL"
echo "==> tauri dev  (QUILL_API_URL=$QUILL_API_URL)"
cd "$GUI"
# Not `exec`: the GUI has to be able to exit so the trap can stop the sidecar.
status=0
eval "$GUI_CMD" || status=$?
exit "$status"
