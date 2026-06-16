#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# verify-memory-os.sh — turnkey go-live check for the Memory OS against a
# DEPLOYED instance. Exercises the real HTTP surface end-to-end and cleans up
# after itself (the write probe is deleted), so it's safe to run against prod.
#
# Usage:
#   BASE_URL=https://your-app.example.com \
#   AGENCY_JWT=<an agency JWT>            \   # or set JWT_SECRET to mint one (needs node+jsonwebtoken)
#   CRON_SECRET=<your CRON_SECRET>        \   # optional — enables the cron-driver checks
#   CLIENT_JWT=<a client JWT>             \   # optional — enables the live tenant-isolation check
#   ./scripts/verify-memory-os.sh
#
# Exit code 0 = all checks passed; non-zero = at least one failed.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

: "${BASE_URL:?set BASE_URL to your deployed base URL}"
BASE_URL="${BASE_URL%/}"
PASS=0; FAIL=0
ok()   { echo "  PASS  $1"; PASS=$((PASS+1)); }
bad()  { echo "  FAIL  $1"; FAIL=$((FAIL+1)); }
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
body() { curl -s "$@"; }

# Resolve an agency JWT: prefer AGENCY_JWT, else mint from JWT_SECRET.
if [ -z "${AGENCY_JWT:-}" ] && [ -n "${JWT_SECRET:-}" ]; then
  AGENCY_JWT=$(node -e "console.log(require('jsonwebtoken').sign({id:'verify',email:'verify@local',role:'agency',client_id:null}, process.env.JWT_SECRET))" 2>/dev/null) \
    || { echo "could not mint a JWT (need node + jsonwebtoken, or pass AGENCY_JWT)"; exit 2; }
fi
: "${AGENCY_JWT:?set AGENCY_JWT (or JWT_SECRET to mint one)}"
AUTH=(-H "Authorization: Bearer ${AGENCY_JWT}")
JSON=(-H 'content-type: application/json')

PROBE="memory-os go-live probe $(date -u +%s)"
PROBE_ID=""
cleanup() { [ -n "$PROBE_ID" ] && curl -s -o /dev/null -X DELETE "$BASE_URL/api/memory/$PROBE_ID" "${AUTH[@]}"; }
trap cleanup EXIT

echo "Memory OS go-live verification → $BASE_URL"
echo

echo "1. governance health (agency)"
H=$(body "$BASE_URL/api/memory/health" "${AUTH[@]}")
echo "$H" | grep -qE '"status":"(healthy|degraded|critical)"' && ok "health verdict returned: $(echo "$H" | grep -oE '"status":"[a-z]+"')" || bad "health endpoint ($H)"

echo "2. write → recall → delete probe (round-trips the engine)"
W=$(body -X POST "$BASE_URL/api/memory" "${AUTH[@]}" "${JSON[@]}" -d "{\"client_id\":\"_verify_\",\"kind\":\"probe\",\"content\":\"$PROBE\",\"source\":\"user\",\"ttlDays\":1}")
PROBE_ID=$(echo "$W" | grep -oE '"id":[0-9]+' | head -1 | grep -oE '[0-9]+')
[ -n "$PROBE_ID" ] && ok "write returned id=$PROBE_ID" || bad "write failed ($W)"
if [ -n "$PROBE_ID" ]; then
  body "$BASE_URL/api/memory/_verify_?kind=probe" "${AUTH[@]}" | grep -qF "$PROBE" && ok "recall sees the probe" || bad "recall missed the probe"
  body "$BASE_URL/api/memory/_verify_?q=probe" "${AUTH[@]}" | grep -q '"semantic":true' && ok "semantic search responds" || bad "semantic search failed"
  curl -s -o /dev/null -X DELETE "$BASE_URL/api/memory/$PROBE_ID" "${AUTH[@]}"
  body "$BASE_URL/api/memory/_verify_?kind=probe" "${AUTH[@]}" | grep -qF "$PROBE" && bad "probe still present after delete" || { ok "delete removed the probe"; PROBE_ID=""; }
fi

if [ -n "${CRON_SECRET:-}" ]; then
  echo "3. daily cron driver (governance + capture)"
  [ "$(code -X POST "$BASE_URL/api/cron/memory" -H 'Authorization: Bearer wrong')" = "401" ] && ok "cron fails closed on a bad bearer (401)" || bad "cron did not 401 on bad bearer"
  body -X POST "$BASE_URL/api/cron/memory" -H "Authorization: Bearer ${CRON_SECRET}" | grep -q '"ok":true' && ok "cron driver ran (governance + capture)" || bad "cron driver did not return ok:true"
else
  echo "3. (skipped — set CRON_SECRET to check the cron driver)"
fi

if [ -n "${CLIENT_JWT:-}" ]; then
  echo "4. live tenant isolation (client token)"
  [ "$(code "$BASE_URL/api/memory" -H "Authorization: Bearer ${CLIENT_JWT}")" = "403" ] && ok "client denied the agency fleet endpoint (403)" || bad "client was NOT denied the fleet endpoint"
else
  echo "4. (skipped — set CLIENT_JWT to check live tenant isolation)"
fi

echo
echo "── $PASS passed, $FAIL failed ──"
[ "$FAIL" -eq 0 ]
