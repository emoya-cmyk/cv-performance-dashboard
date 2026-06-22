# Security — secrets handling & the PIT rotation runbook

Canonical for the emoya-cmyk performance-dashboard family (adopt per repo).

## Secret-handling model (how it's supposed to work)

- **Per-tenant credentials** (e.g. the GHL Private Integration Token) are stored
  **AES-256 encrypted in the DB**, decrypted only at sync time, and **never
  returned in API responses** (PRD). They are read as `creds.api_key` and used as
  `Bearer ${creds.api_key}` at request time — never hardcoded.
- **Process secrets** (`JWT_SECRET`, `CRON_SECRET`, `MAKE_WEBHOOK_SECRET`,
  `INTEGRATION_HEALTH_SECRET`, `ANTHROPIC_API_KEY`, `DATABASE_URL`) come from the
  host environment. Boot **fails closed** without the required ones.
- Error surfaces run through a **redaction** helper (`redactError`) so a leaked
  `Bearer …` in an upstream error never lands in a log or response.

## Controls in place (verified this audit)

- **No secret is committed.** Full-history scan across all five repos: no `.env`
  ever committed; no real token value in working tree or history (the only match
  is a synthetic test fixture for the redaction test).
- **Agent vector blocked.** The dev-time harness denies the agent reading/editing
  `.env*` / `secrets/**` (`permissions.deny` + `block-dangerous.sh`), so an
  automated loop can't exfiltrate or commit a secret.
- `.env.example` files are committed (templates, no values); real `.env` is ignored.

## OPEN — operator actions (cannot be done from a code session)

1. **Rotate the exposed PIT token.** GHL → Settings → API → Private Integrations →
   revoke the exposed token, create a new one, update the tenant's stored
   credential. The exposure was operational (outside git), so rotation is the only
   remediation — there is nothing to scrub from the repo.
2. **Enable GitHub secret-scanning + push protection** on every repo in the family
   (Settings → Code security). This is the robust, maintained control — it blocks a
   real secret at push time, entropy-based, with far fewer false positives than a
   hand-rolled regex test (which is why this repo ships none).

## Ongoing

- New credential types must follow the model above (encrypted at rest, env for
  process secrets, redaction on error paths). Add a `DECISION_REGISTER.md` entry if
  a new secret store or identity key is introduced.
- The `mcp__github__run_secret_scanning` tool is available for targeted scans of
  specific diffs/snippets during review.
