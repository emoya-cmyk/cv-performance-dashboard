"""Smoke test + DB-adapter example for the Python memory_os port.

Runs against stdlib sqlite3 — no external deps. Proves the core invariants:
scope isolation, cross-write block, precedence, dedup, forget.

    python test_smoke.py
"""
import os
import re
import sqlite3

from memory_os import Memory


class _Result:
    def __init__(self, rows, rowcount):
        self.rows = rows
        self.rowcount = rowcount


def make_query(db):
    """Adapter: pg-style $N -> sqlite ?, RETURNING reconstructed via lastrowid."""
    def query(sql, params=()):
        out = re.sub(r"\$\d+", "?", sql)
        ret = re.search(r"RETURNING\s+(.+)$", out, re.I)
        stripped = out[: ret.start()].strip() if ret else out
        cur = db.execute(stripped, list(params))
        if re.match(r"\s*(SELECT|WITH)", stripped, re.I):
            return _Result([dict(r) for r in cur.fetchall()], cur.rowcount)
        if ret and re.match(r"\s*INSERT", stripped, re.I):
            row = db.execute("SELECT * FROM agent_memory WHERE rowid=?", (cur.lastrowid,)).fetchone()
            return _Result([dict(row)], 1)
        db.commit()
        return _Result([], cur.rowcount)
    return query


def main():
    db = sqlite3.connect(":memory:")
    db.row_factory = sqlite3.Row
    schema = os.path.join(os.path.dirname(__file__), "schema.sqlite.sql")
    db.executescript(open(schema).read())

    mem = Memory(make_query(db))
    A = {"role": "client", "client_id": "A"}
    AG = {"role": "agency"}

    mem.remember(AG, {"client_id": "A", "kind": "k", "content": "A secret", "source": "user"})
    mem.remember(AG, {"client_id": "B", "kind": "k", "content": "B secret", "source": "user"})

    a = [m["content"] for m in mem.recall(A)]
    assert a == ["A secret"], a                       # scope isolation

    leaked = False
    try:
        mem.remember(A, {"client_id": "B", "kind": "k", "content": "x", "source": "user"})
    except ValueError:
        leaked = True
    assert leaked, "cross-tenant write must be blocked"

    mem.remember(AG, {"client_id": "P", "kind": "k", "content": "hist", "source": "history"})
    mem.remember(AG, {"client_id": "P", "kind": "k", "content": "pol", "source": "policy"})
    order = [m["source"] for m in mem.recall(AG, {"client_id": "P"})]
    assert order[0] == "policy", order                # precedence

    dup = mem.remember(AG, {"client_id": "P", "kind": "k", "content": "pol", "source": "fact"})
    assert dup["deduped"] is True                     # dedup-reinforce

    assert mem.forget(AG, {"client_id": "P"}) == 2    # forget own rows
    print("memory_os.py smoke: OK")


if __name__ == "__main__":
    main()
