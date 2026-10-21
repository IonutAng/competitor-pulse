#!/usr/bin/env bash
# Small helper for demos and manual checks against a running stack.
#
#   scripts/demo.sh add <id>        track a competitor
#   scripts/demo.sh show <id>       print its snapshots, newest first (one line each)
#   scripts/demo.sh poll <id>       ask for an immediate poll
#   scripts/demo.sh remove <id>     stop tracking it
#   scripts/demo.sh list            tracked competitors
#   scripts/demo.sh stats           how many completions the mock LLM has served
#   scripts/demo.sh fail-next <n>   make the mock LLM fail the next n calls with HTTP 500
#   scripts/demo.sh latency <ms>    add artificial latency to every mock LLM call
#   scripts/demo.sh reset           reset the mock LLM (count, latency, failures)
#
# APP (default http://localhost:3000) and MOCK (default http://localhost:4001) can be overridden.
set -euo pipefail

APP=${APP:-http://localhost:3000}
MOCK=${MOCK:-http://localhost:4001}

json() { curl -sS -H 'content-type: application/json' "$@"; }

usage() { sed -n '2,15p' "$0"; exit 1; }
case "${1:-}" in
  add|remove|poll|show|fail-next|latency) [ $# -ge 2 ] || usage ;;
esac

case "${1:-}" in
  add)     json -X POST -d "{\"id\":\"$2\"}" -w '\nHTTP %{http_code}\n' "$APP/api/competitors" ;;
  remove)  curl -sS -X DELETE -w 'HTTP %{http_code}\n' "$APP/api/competitors/$2" ;;
  poll)    curl -sS -X POST -w '\nHTTP %{http_code}\n' "$APP/api/competitors/$2/poll" ;;
  list)    curl -sS "$APP/api/competitors"; echo ;;
  show)
    curl -sS "$APP/api/competitors/$2/snapshots" | node -e '
      const rows = JSON.parse(require("fs").readFileSync(0, "utf8"));
      if (!Array.isArray(rows)) { console.log(JSON.stringify(rows)); process.exit(0); }
      for (const s of rows) {
        const state = s.isInitial ? "initial" : s.changed ? `changed [${s.changedFields}] summary=${s.summaryStatus}` : "no change";
        const extra = s.summary ? `\n      ${s.summary}` : s.summaryError ? `\n      error: ${s.summaryError}` : "";
        console.log(`#${s.id}  ${s.fetchedAt}  ${s.price.padEnd(28)}  ${state}${extra}`);
      }' ;;
  stats)     curl -sS "$MOCK/control/stats"; echo ;;
  fail-next) json -X POST -d "{\"failNext\":$2}" "$MOCK/control/configure"; echo ;;
  latency)   json -X POST -d "{\"latencyMs\":$2}" "$MOCK/control/configure"; echo ;;
  reset)     curl -sS -X POST "$MOCK/control/reset"; echo ;;
  *) usage ;;
esac
