#!/usr/bin/env bash
# Behaviour harness for the host progress watchdog.
#
# The watchdog is the only thing in this deployment that can restart production unattended, and it
# runs on the host where no unit test reaches it, so it is exercised here instead. The script under
# test is extracted from terraform/azure/cloud-init.yaml on every run rather than kept as a copy:
# a duplicate would drift from what actually ships, which is the failure this is meant to prevent.
#
# Only the two absolute paths the script cannot take as input are substituted (its config and its
# tmpfs state file), plus stub curl and docker on PATH. Every decision is the shipped code.
#
# Usage: bash scripts/devtools/testProgressWatchdog.sh
set -u
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CLOUD_INIT="$REPO_ROOT/terraform/azure/cloud-init.yaml"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/bin"

# Pull the block out of the YAML by path marker, then strip the six-space content indent.
awk '
  /^  - path: \/usr\/local\/sbin\/tomoribot-progress-watchdog\.sh$/ { found = 1; next }
  found && /^    content: \|$/ { emit = 1; next }
  emit && /^  - path: / { exit }
  emit { sub(/^      /, ""); print }
' "$CLOUD_INIT" > "$WORK/wd-src.sh"

if [ ! -s "$WORK/wd-src.sh" ]; then
  echo "could not extract the watchdog from $CLOUD_INIT" >&2
  exit 1
fi
bash -n "$WORK/wd-src.sh" || { echo "extracted watchdog is not valid bash" >&2; exit 1; }

CONF="$WORK/watchdog.conf"
STATE="$WORK/state"
sed -e "s#^CONF=/etc/tomoribot/watchdog.conf#CONF=$CONF#"     -e "s#^STATE=/run/tomoribot-watchdog.state#STATE=$STATE#"     "$WORK/wd-src.sh" > "$WORK/wd.sh"
chmod +x "$WORK/wd.sh"

# curl stub: STALENESS unset means the probe fails; NOBODY=1 means a body without the field.
cat > "$WORK/bin/curl" <<'STUB'
#!/usr/bin/env bash
for a in "$@"; do [ "$a" = "-o" ] && QUIET=1; done
if [ "${PROBE_FAIL:-0}" = "1" ]; then exit 7; fi
if [ "${NOBODY:-0}" = "1" ]; then echo '{"status":"healthy"}'; exit 0; fi
echo "{\"status\":\"healthy\",\"eventLoop\":{\"running\":true,\"stalenessMs\":${STALENESS:-300},\"lastLagMs\":2}}"
exit 0
STUB

# docker stub: records restarts so the armed path can be asserted rather than inferred.
cat > "$WORK/bin/docker" <<'STUB'
#!/usr/bin/env bash
case "$1" in
  ps) echo "cid$( [ "${2:-}" = "-q" ] && echo "" )abc" ;;
  inspect)
    if [ "${NO_CONTAINER:-0}" = "1" ]; then exit 1; fi
    echo "${STARTED_AT:-2026-08-18T00:00:00.000000000Z}" ;;
  restart) echo "RESTARTED $*" >> "$RESTART_LOG" ;;
esac
exit 0
STUB
chmod +x "$WORK/bin/curl" "$WORK/bin/docker"
export PATH="$WORK/bin:$PATH"
export RESTART_LOG="$WORK/restarts.log"
: > "$RESTART_LOG"

pass=0; fail=0
check() { # name expected actual
  if [ "$2" = "$3" ]; then pass=$((pass+1)); echo "  ok   $1"
  else fail=$((fail+1)); echo "  FAIL $1: expected [$2] got [$3]"; fi
}

reset() { rm -f "$STATE"; : > "$RESTART_LOG"; rm -f "$CONF"; }
runs() { # n -> last output
  local out=""
  for _ in $(seq 1 "$1"); do out=$("$WORK/wd.sh" 2>&1); done
  echo "$out"
}

echo "1. healthy stays silent and resets the counter"
reset
out=$(STALENESS=300 runs 3)
check "no action" "" "$(echo "$out" | grep -c OBSERVE-ONLY | sed 's/^0$//')"
check "counter zero" "FAILURES=0" "$(grep FAILURES "$STATE")"

echo "2. a stall needs five consecutive checks, not one"
reset
out=$(STALENESS=60000 runs 4)
check "silent at 4" "0" "$(echo "$out" | grep -c OBSERVE-ONLY)"
out=$(STALENESS=60000 runs 1)
check "fires at 5" "1" "$(echo "$out" | grep -c OBSERVE-ONLY)"
check "disarmed: nothing restarted" "0" "$(wc -l < "$RESTART_LOG" | tr -d ' ')"

echo "3. one healthy check resets the streak"
reset
STALENESS=60000 runs 4 > /dev/null
STALENESS=300 runs 1 > /dev/null
out=$(STALENESS=60000 runs 4)
check "streak restarted" "0" "$(echo "$out" | grep -c OBSERVE-ONLY)"

echo "4. an unreachable probe counts as no progress"
reset
out=$(PROBE_FAIL=1 runs 5)
check "fires on timeout" "1" "$(echo "$out" | grep -c OBSERVE-ONLY)"
check "reason names the probe" "1" "$(echo "$out" | grep -c 'probe failed rc=7' | sed 's/^[2-9]$/1/')"

echo "5. a build without the field is not a stall"
reset
out=$(NOBODY=1 runs 6)
check "skips" "1" "$(echo "$out" | grep -c 'predates the event-loop monitor')"
check "never accumulates" "FAILURES=0" "$(grep FAILURES "$STATE")"

echo "6. startup grace blocks action on a young container"
reset
out=$(STALENESS=60000 STARTED_AT="$(date -u -d '-2 minutes' +%Y-%m-%dT%H:%M:%S.000000000Z)" runs 5)
check "grace holds" "1" "$(echo "$out" | grep -c 'grace; not acting')"

echo "7. armed actually recycles, co-tenants first"
reset
echo "WATCHDOG_ARMED=true" > "$CONF"
out=$(STALENESS=60000 runs 5)
check "acted" "1" "$(echo "$out" | grep -c '^ACTING:')"
check "two restarts" "2" "$(wc -l < "$RESTART_LOG" | tr -d ' ')"
check "searxng first" "1" "$(head -1 "$RESTART_LOG" | grep -c ' 15 ')"
check "bot second, 30s grace" "1" "$(tail -1 "$RESTART_LOG" | grep -c ' 30 ')"

echo "8. rate limit blocks a second recycle and says so loudly"
reset
echo "WATCHDOG_ARMED=true" > "$CONF"
STALENESS=60000 runs 5 > /dev/null
out=$(STALENESS=60000 runs 5)
check "alerts" "1" "$(echo "$out" | grep -c '^ALERT:')"

echo
echo "passed=$pass failed=$fail"
[ "$fail" -eq 0 ]
