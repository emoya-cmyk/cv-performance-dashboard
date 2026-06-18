#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# verify-write-verification.sh — turnkey check of the write-verification ingest
# loop (Spec A) against a DEPLOYED instance. Posts one VERIFIED_CORRECT probe to
# the machine webhook (exactly as cli_framework will), then reads it back via the
# operator correctness endpoint and asserts it landed. Uses a throwaway probe
# tenant so it's safe to run against prod (it adds one stats row for a synthetic
# tenant; nothing else is touched).
#
# For a self-contained check with NO deployment, use:  node scripts/smoke-write-verification.mjs
#
# Usage:
#   BASE_URL=https://your-app.example.com   \
#   MAKE_WEBHOOK_SECRET=<the webhook secret> \
#   AGENCY_JWT=<an agency JWT>               \   # or set JWT_SECRET to mint one (needs node+jsonwebtoken)
#   ./scripts/verify-write-verification.sh
#
# Exit 0 = passed; non-zero = at least one check failed.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

: "${BASE_URL:?set BASE_URL to your deployed base URL}"
: "${MAKE_WEBHOOK_SECRET:?set MAKE_WEBHOOK_SECRET (the ingest webhook secret)}"
BASE_URL="${BASE_URL%/}"
PASS=0; FAIL=0
ok()  { echo "  PASS  $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL  $1"; FAIL=$((FAIL+1)); }

# Resolve an agency JWT: prefer AGENCY_JWT, else mint from JWT_SECRET.
if [ -z "${AGENCY_JWT:-}" ] && [ -n "${JWT_SECRET:-}" ]; then
  AGENCY_JWT=$(node -e "console.log(require('jsonwebtoken').sign({id:'verify',email:'verify@local',role:'agency',client_id:null}, process.env.JWT_SECRET))" 2>/dev/null) \
    || { echo "could not mint a JWT (need node + jsonwebtoken, or pass AGENCY_JWT)"; exit 2; }
fi
: "${AGENCY_JWT:?set AGENCY_JWT (or JWT_SECRET to mint one)}"

TENANT="wv-verify-$(date -u +%s)"
ENDPOINT="verify:probe"

echo "Write-verification verification → $BASE_URL  (probe tenant: $TENANT)"

# 1. Machine ingest: a VERIFIED_CORRECT probe, exactly as cli_framework posts.
INGEST=$(cat <<JSON
{ "tenant_id":"$TENANT","endpoint":"$ENDPOINT","persisted":true,
  "canonical_id":"probe-1","canonical_id_kind":"primary",
  "intended":{"status":"won"},"read_back":{"status":"won"} }
JSON
)
RESP=$(curl -s -X POST "$BASE_URL/api/webhooks/write-verification" \
  -H "x-make-signature: $MAKE_WEBHOOK_SECRET" -H 'content-type: application/json' \
  -d "$INGEST")
echo "$RESP" | grep -q '"outcome":"VERIFIED_CORRECT"' \
  && ok "ingest → VERIFIED_CORRECT" || bad "ingest → $RESP"

# 2. Bad signature is rejected (fail-closed).
SCODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE_URL/api/webhooks/write-verification" \
  -H "x-make-signature: wrong" -H 'content-type: application/json' -d "$INGEST")
[ "$SCODE" = "401" ] && ok "bad signature → 401" || bad "bad signature → $SCODE (want 401)"

# 3. Operator read reflects the probe (agency-only).
CORR=$(curl -s "$BASE_URL/api/make-remediation/correctness?tenant_id=$TENANT" \
  -H "Authorization: Bearer $AGENCY_JWT")
echo "$CORR" | grep -q "\"$ENDPOINT\"" \
  && echo "$CORR" | grep -q '"verified_correct":1' \
  && ok "correctness read reflects the probe" || bad "correctness read → $CORR"

# 4. Client token is forbidden on the operator read (tenant-safety).
if [ -n "${CLIENT_JWT:-}" ]; then
  CCODE=$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL/api/make-remediation/correctness" \
    -H "Authorization: Bearer $CLIENT_JWT")
  [ "$CCODE" = "403" ] && ok "client token → 403 on operator read" || bad "client token → $CCODE (want 403)"
fi

echo ""
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
