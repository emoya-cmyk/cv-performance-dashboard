# Go-Live — Memory OS

The steps to take the Memory OS from "merged + tested" to "verified running in
your deployment." Operator-only (secrets, crons, connecting accounts) — the code
is done. See `HANDOFF.md` §4.8 for what the layer is.

## 1. Operator gates (set once in your host's dashboard)
- **`JWT_SECRET`** — required; prod boot fails closed without a real value.
- **`CRON_SECRET`** — arms the cron drivers (`/api/cron/heartbeat`, `/api/cron/memory`).
- **`ANTHROPIC_API_KEY`** — *optional*; unset = recap/brief render grounded templates.
- (See `render.yaml` / `HANDOFF.md` for the full list + the OAuth account connections.)

## 2. Schedule the Memory OS autonomy
- **Vercel:** already automatic — `vercel.json` crons run `/api/cron/tick` (daily) and
  `/api/cron/memory` (daily 08:30). Nothing to do.
- **Render / other:** add a **daily** external cron (Render Cron Job, cron-job.org, …) to
  `GET|POST https://<app>/api/cron/memory` with `Authorization: Bearer <CRON_SECRET>` —
  alongside the existing ~15-min heartbeat cron.

## 3. Verify it live (one command)
Get an agency JWT (log into the app, copy the bearer) and run:
```bash
BASE_URL=https://<your-app> \
AGENCY_JWT=<agency bearer> \
CRON_SECRET=<your CRON_SECRET> \
CLIENT_JWT=<a client bearer> \      # optional — checks live tenant isolation
./scripts/verify-memory-os.sh
```
It round-trips the real HTTP surface — governance health, write → recall → semantic
search → delete (self-cleaning probe), the daily cron driver (incl. fail-closed on a
bad bearer), and tenant isolation — and exits non-zero if anything fails. Expected:
`N passed, 0 failed`.

## 4. Watch the loop deliver
Once a client's accounts are connected and the producers run:
- The weekly capture (`/api/cron/memory` daily, or the in-process weekly sweep) remembers
  each client's highlights.
- The weekly recap draws a through-line from prior weeks (grounding intact).
- `GET /api/memory/health` (and the **Performance Memory** / **Memory health** badges on the
  agency Intelligence page) show the store filling and staying healthy.

That's the last gap to a true 10: confirm the above against the live deploy.
