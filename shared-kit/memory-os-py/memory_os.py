"""
memory_os — portable, scoped, decaying agent memory (Python port).

A faithful port of @emoya-cmyk/memory-os. Decoupled from any one app: you inject
a ``query(sql, params) -> Result`` callable (pg-style ``$1..$N`` placeholders,
returning an object/dict with ``rows`` (list of dict-like) and ``rowcount``).
Works on Postgres or SQLite behind that seam.

    mem = Memory(query)
    mem.remember({"role": "agency"}, {"client_id": "acme", "kind": "highlight",
                                      "content": "Revenue up 33%", "source": "derived"})
    hits = mem.recall({"role": "client", "client_id": "acme"}, {"kind": "highlight"}, k=5)

Invariants (identical to the JS engine):
  * SCOPE      — a 'client' scope can never read/write another tenant's rows.
  * PRECEDENCE — authority tier from source; higher wins conflicts + ranking ties.
  * DECAY/TTL  — confidence decays from last-reinforced time; hard TTL; forget;
                 compact reclaims long-dead rows (live rows never touched).
"""

from datetime import datetime, timezone

AUTHORITY = {"policy": 5, "user": 4, "fact": 3, "derived": 2, "ai": 1, "history": 0}
_DAY_S = 86_400.0


def _now_iso():
    return datetime.now(timezone.utc).isoformat()


def _same_id(a, b):
    if a in (None, "") or b in (None, ""):
        return False
    return str(a).strip() == str(b).strip()


def _age_days(iso, now):
    try:
        t = datetime.fromisoformat(str(iso).replace("Z", "+00:00"))
        n = datetime.fromisoformat(str(now).replace("Z", "+00:00"))
        return (n - t).total_seconds() / _DAY_S
    except Exception:
        return 0.0


def _rows(result):
    # Accept either an object with .rows / .rowcount or a dict.
    if isinstance(result, dict):
        return result.get("rows", []), result.get("rowcount", result.get("rowCount", 0))
    return getattr(result, "rows", []), getattr(result, "rowcount", getattr(result, "rowCount", 0))


class Memory:
    def __init__(self, query, table="agent_memory", half_life_days=30):
        if not callable(query):
            raise ValueError("memory_os: a query(sql, params) callable is required")
        self.q = query
        self.table = table
        self.half_life = half_life_days

    # ── helpers ────────────────────────────────────────────────────────────
    def _decay(self, age_days):
        return 0.5 ** (age_days / self.half_life) if age_days > 0 else 1.0

    @staticmethod
    def _scope(scope):
        if not scope or scope.get("role") not in ("agency", "client"):
            raise ValueError('memory_os: invalid scope (role must be "agency" or "client")')
        if scope["role"] == "client" and not scope.get("client_id"):
            raise ValueError("memory_os: client scope requires a client_id")
        return scope

    @staticmethod
    def _write_client_id(scope, claim_client_id):
        if scope["role"] == "agency":
            return claim_client_id
        if claim_client_id is not None and not _same_id(claim_client_id, scope["client_id"]):
            raise ValueError("memory_os: client scope cannot write to another client_id")
        return scope["client_id"]

    @staticmethod
    def _client_eq(clauses, params, client_id):
        if client_id is None:
            clauses.append("client_id IS NULL")
        else:
            params.append(client_id)
            clauses.append(f"client_id = ${len(params)}")

    # ── remember ───────────────────────────────────────────────────────────
    def remember(self, scope, claim):
        self._scope(scope)
        kind = str(claim.get("kind", "")).strip()
        content = str(claim.get("content", "")).strip()
        source = str(claim.get("source", "")).strip()
        if not kind:
            raise ValueError("memory_os: claim.kind required")
        if not content:
            raise ValueError("memory_os: claim.content required")
        if source not in AUTHORITY:
            raise ValueError(f'memory_os: unknown source "{source}"')

        client_id = self._write_client_id(scope, claim.get("client_id"))
        authority = AUTHORITY[source]
        conf = claim.get("confidence", 1)
        try:
            conf = min(1.0, max(0.0, float(conf)))
        except (TypeError, ValueError):
            conf = 1.0
        now = _now_iso()
        ttl = claim.get("ttl_days")
        expires = None
        if ttl and float(ttl) > 0:
            expires = datetime.fromisoformat(now).timestamp() + float(ttl) * _DAY_S
            expires = datetime.fromtimestamp(expires, timezone.utc).isoformat()
        evidence = claim.get("evidence_ref")

        fc, fp = ["forgotten_at IS NULL"], []
        fp.append(kind); fc.append(f"kind = ${len(fp)}")
        fp.append(content); fc.append(f"content = ${len(fp)}")
        self._client_eq(fc, fp, client_id)
        rows, _ = _rows(self.q(
            f"SELECT id, confidence, authority, source, evidence_ref FROM {self.table} "
            f"WHERE {' AND '.join(fc)} LIMIT 1", fp))

        if rows:
            row = rows[0]
            keep_new = authority >= int(row["authority"])
            self.q(
                f"UPDATE {self.table} SET confidence=$1, authority=$2, source=$3, "
                f"evidence_ref=$4, updated_at=$5, expires_at=$6 WHERE id=$7",
                [max(float(row["confidence"]), conf), max(int(row["authority"]), authority),
                 source if keep_new else row["source"],
                 evidence if keep_new else row.get("evidence_ref"), now, expires, row["id"]])
            return {"id": row["id"], "deduped": True}

        ins, _ = _rows(self.q(
            f"INSERT INTO {self.table} (client_id, kind, content, source, authority, confidence, "
            f"evidence_ref, created_at, updated_at, expires_at) "
            f"VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id",
            [client_id, kind, content, source, authority, conf, evidence, now, now, expires]))
        return {"id": ins[0]["id"], "deduped": False}

    # ── recall ─────────────────────────────────────────────────────────────
    def recall(self, scope, query=None, k=10, now=None):
        self._scope(scope)
        query = query or {}
        now = now or _now_iso()
        clauses = ["forgotten_at IS NULL", "(expires_at IS NULL OR expires_at > $1)"]
        params = [now]
        if scope["role"] == "client":
            self._client_eq(clauses, params, scope["client_id"])
        elif "client_id" in query:
            self._client_eq(clauses, params, query["client_id"])
        if query.get("kind"):
            params.append(query["kind"]); clauses.append(f"kind = ${len(params)}")
        if query.get("text"):
            params.append(f"%{str(query['text']).lower()}%")
            clauses.append(f"LOWER(content) LIKE ${len(params)}")

        rows, _ = _rows(self.q(
            f"SELECT id, client_id, kind, content, source, authority, confidence, evidence_ref, "
            f"created_at, updated_at, expires_at FROM {self.table} WHERE {' AND '.join(clauses)}", params))

        out = []
        for r in rows:
            conf = float(r["confidence"])
            out.append({
                "id": r["id"], "client_id": r.get("client_id"), "kind": r["kind"],
                "content": r["content"], "source": r["source"], "authority": int(r["authority"]),
                "confidence": conf,
                "effective_confidence": conf * self._decay(_age_days(r["updated_at"], now)),
                "evidence_ref": r.get("evidence_ref"),
                "created_at": r["created_at"], "updated_at": r["updated_at"],
                "expires_at": r.get("expires_at"),
            })
        out.sort(key=lambda m: (m["effective_confidence"], m["authority"], m["updated_at"], m["id"]),
                 reverse=True)
        return out[:k]

    # ── forget ─────────────────────────────────────────────────────────────
    def forget(self, scope, selector=None):
        self._scope(scope)
        selector = selector or {}
        now = _now_iso()
        clauses, params = ["forgotten_at IS NULL"], [now]
        if selector.get("id") is not None:
            params.append(selector["id"]); clauses.append(f"id = ${len(params)}")
        if selector.get("kind"):
            params.append(selector["kind"]); clauses.append(f"kind = ${len(params)}")
        if selector.get("content"):
            params.append(selector["content"]); clauses.append(f"content = ${len(params)}")
        if scope["role"] == "client":
            self._client_eq(clauses, params, scope["client_id"])
        elif "client_id" in selector:
            self._client_eq(clauses, params, selector["client_id"])
        _, n = _rows(self.q(f"UPDATE {self.table} SET forgotten_at = $1 WHERE {' AND '.join(clauses)}", params))
        return n or 0

    # ── compact ────────────────────────────────────────────────────────────
    def compact(self, retention_days=90, now=None):
        now = now or _now_iso()
        cutoff = datetime.fromisoformat(now).timestamp() - max(0, retention_days) * _DAY_S
        cutoff = datetime.fromtimestamp(cutoff, timezone.utc).isoformat()
        _, n = _rows(self.q(
            f"DELETE FROM {self.table} WHERE (forgotten_at IS NOT NULL AND forgotten_at < $1) "
            f"OR (expires_at IS NOT NULL AND expires_at < $1)", [cutoff]))
        return n or 0
