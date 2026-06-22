# Write-Verification Ingest Contract (`cli_framework` → dashboard)

The contract `cli_framework` implements to light up the correctness loop (Spec A).
Until it posts here, the loop is dark and the `Write correctness` tile reads
empty. This is the *only* integration needed to turn the primitive from built →
live. See `CLI_FRAMEWORK_AUDIT.md` for what to verify on the framework side.

## Endpoint

```
POST /api/webhooks/write-verification
Header: x-make-signature: <MAKE_WEBHOOK_SECRET>     # required — fail-closed (SHA-256 constant-time compare)
Content-Type: application/json
```

Fail-closed: `503` when `MAKE_WEBHOOK_SECRET` is **unset** (ingest disabled — the
secret must be configured), `401` on a bad/missing signature, `400` if `tenant_id`,
`endpoint`, or a boolean `persisted` is missing.

## Body

| field | req | meaning |
|---|---|---|
| `tenant_id` | ✓ | the cli tenant the write targeted |
| `endpoint` | ✓ | scoping unit, e.g. `acculynx:job.update` — correctness accrues per `(tenant_id, endpoint)` |
| `persisted` | ✓ | did the write land at all? (boolean) |
| `intended` | – | the field→value payload you tried to write |
| `read_back` | – | the record **re-read by canonical identity**; **omit or `null`** if the read is unavailable |
| `vendor` | – | convenience label |
| `scenario_id`, `execution_id` | – | cross-refs to the remediation log |
| `canonical_id`, `canonical_id_kind` | – | the identity used for read-back (`primary`/`email_fallback`/`phone_fallback`) |
| `equivalence` | – | per-field normalization: `{ field: { kind?: 'email'\|'phone', map?: {vendorVal: canonicalVal} } }` |
| `note` | – | freeform |

## Outcome (derived server-side — you don't send it)

| `persisted` | `read_back` | comparison | → outcome |
|---|---|---|---|
| `false` | — | — | `FAILED` |
| `true` | omitted / `null` | — | `PERSISTED_UNVERIFIED` |
| `true` | present | all intended fields match (normalized) | `VERIFIED_CORRECT` |
| `true` | present | any field mismatches | `PERSISTED_INCORRECT` |

Response: `{ ok, id, outcome, mismatchFields, readBackAvailable }`.

## Rules `cli_framework` MUST follow (these are the audit's Section A)

1. **`read_back` is a TRUE re-read** from the vendor by canonical id — never an echo
   of `intended` (an echo always reports `VERIFIED_CORRECT` = false trust).
2. **On consistency lag, send `read_back: null`** (→ `PERSISTED_UNVERIFIED`). Never
   fabricate a read-back.
3. **Normalize on ONE side only.** Send raw values + an `equivalence` map and let
   the dashboard normalize. Don't pre-normalize *and* send a map (double-normalize)
   or send neither when representations differ (false mismatch).
4. **Retry / dead-letter the POST** on failure so correctness samples aren't lost.
5. **Send `x-make-signature`.** GET-only vendors (AccuLynx) post the operator's
   manual change here too — the manual path is measured on the same axis.

## Read side (operators)

```
GET /api/make-remediation/correctness?tenant_id=...      # agency JWT
→ { scope, endpoints:[{tenant_id, endpoint, failed, persisted_unverified,
     persisted_incorrect, verified_correct, total, verified_rate, wilson_lower}], count }
```

`verified_rate` and `wilson_lower` are **reporting-only** today — they do NOT gate
promotion yet (Spec A sequencing: accumulate real samples first).

## Example payloads

```jsonc
// VERIFIED_CORRECT — wrote it, re-read it, matches (phone normalized via equivalence)
{ "tenant_id":"t-acme","endpoint":"acculynx:job.update","persisted":true,
  "canonical_id":"job_123","canonical_id_kind":"primary",
  "intended":{"phone":"(555) 123-4567","status":"won"},
  "read_back":{"phone":"5551234567","status":"won"},
  "equivalence":{"phone":{"kind":"phone"}} }

// PERSISTED_INCORRECT — saved, but the vendor holds a different value (logged as such)
{ "tenant_id":"t-acme","endpoint":"acculynx:job.update","persisted":true,
  "canonical_id":"job_123","intended":{"status":"won"},"read_back":{"status":"lost"} }

// PERSISTED_UNVERIFIED — saved, read-back not yet available (eventual consistency)
{ "tenant_id":"t-acme","endpoint":"acculynx:job.update","persisted":true,
  "canonical_id":"job_123","intended":{"status":"won"},"read_back":null }

// FAILED — did not persist
{ "tenant_id":"t-acme","endpoint":"acculynx:job.update","persisted":false,
  "intended":{"status":"won"} }
```

## Verify it

- Local / self-contained (no deployment): `node scripts/smoke-write-verification.mjs`
- Against a deployment: `BASE_URL=… JWT_SECRET=… MAKE_WEBHOOK_SECRET=… ./scripts/verify-write-verification.sh`
