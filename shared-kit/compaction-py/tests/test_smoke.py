"""Self-contained fidelity test for the Python compaction port (no pytest).

Prints + asserts; exits non-zero on failure (the kit's Python test convention).
Runs the SAME golden fixtures the JS suite uses (../../compaction/test/fixtures),
and pins the ``enc=v1`` format to the SAME bytes the JS golden test pins — so the
two language ports are proven to be one wire format, not two look-alikes.

    python3 tests/test_smoke.py
"""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from compaction import (  # noqa: E402
    compact,
    expand,
    encode_table,
    decode_table,
    round_trips_lossless,
    json_equal,
    MIN_ROWS,
    MIN_TOKENS,
    CORE_FIELD_FRACTION,
    HETEROGENEOUS_CORE_RATIO,
    ENC_VERSION,
)
import cache_align  # noqa: E402

FIXTURES = os.path.join(os.path.dirname(__file__), "..", "..", "compaction", "test", "fixtures")
COMPACTABLE = [
    "ghl_contacts.json",
    "acculynx_jobs.json",
    "hcp_jobs.json",
    "makecom_scenario_health.json",
    "dashboard_synthesis.json",
]


def load(name):
    with open(os.path.join(FIXTURES, name), encoding="utf-8") as f:
        return json.load(f)


def main():
    # ── the core guarantee, per golden fixture ────────────────────────────────
    for name in COMPACTABLE:
        original = load(name)
        res = compact(original)
        assert res["compacted"] is True, "%s should compact" % name
        assert res["compacted_chars"] < res["original_chars"], "%s should shrink" % name
        assert res["ratio"] < 1, "%s ratio < 1" % name
        assert json_equal(expand(res["text"]), original), "%s must round-trip" % name
        assert round_trips_lossless(original, res["text"]), "%s roundTripsLossless" % name
        pct = 100 * (1 - res["ratio"])
        print("  %s: %d -> %d chars (%.1f%% smaller)" % (
            name, res["original_chars"], res["compacted_chars"], pct))

    # ── passthrough paths (still lossless) ────────────────────────────────────
    small = load("below_threshold.json")
    r = compact(small)
    assert r["compacted"] is False and r["reason"] == "below-min-rows"
    assert json_equal(expand(r["text"]), small)

    tiny = [{"a": i} for i in range(6)]
    r = compact(tiny)
    assert r["compacted"] is False and r["reason"] == "below-min-tokens"
    assert json_equal(expand(r["text"]), tiny)

    het = load("heterogeneous.json")
    r = compact(het)
    assert r["compacted"] is False and r["reason"] == "heterogeneous"
    assert json_equal(expand(r["text"]), het)

    for v in [42, "hello", {"a": 1}, [1, 2, 3], [{"a": 1}, 5], None]:
        r = compact(v)
        assert r["compacted"] is False
        assert json_equal(expand(r["text"]), v)

    # ── adversarial cells ─────────────────────────────────────────────────────
    rows = [
        {"id": "a", "s": "has|pipe", "n": 1, "b": True},
        {"id": "b", "s": "has\nnewline\tand\r", "n": -3.5, "b": False},
        {"id": "c", "s": "back\\slash and \\| and \\z literal", "n": 0, "b": True},
        {"id": "d", "s": "", "n": 1e21, "b": False},
        {"id": "e", "s": "unicode ☂ é 日本語", "n": 3.14159, "b": True},
        {"id": "f", "n": 7, "b": False},
        {"id": "g", "s": "x", "b": True},
    ]
    assert json_equal(decode_table(encode_table(rows)), rows)

    mixed = [
        {"id": 1, "mixed": None, "nested": {"city": "Austin", "zip": "78704"}},
        {"id": 2, "mixed": "text|with|pipes", "nested": ["a", "b", "c"]},
        {"id": 3, "mixed": 42, "nested": {"deep": {"x": [1, 2, {"y": None}]}}},
        {"id": 4, "mixed": True, "nested": {}},
        {"id": 5, "mixed": 3.14, "nested": []},
    ]
    assert json_equal(decode_table(encode_table(mixed)), mixed)

    # empty string vs null vs absent — three distinct states
    states = [{"id": 1, "v": ""}, {"id": 2, "v": None}, {"id": 3}, {"id": 4, "v": "x"}, {"id": 5, "v": "y"}]
    back = decode_table(encode_table(states))
    assert back[0]["v"] == ""
    assert back[1]["v"] is None
    assert "v" not in back[2]
    assert json_equal(back, states)

    # ── verify-fallback predicate (load-bearing, proven both ways) ────────────
    ghl = load("ghl_contacts.json")
    text = encode_table(ghl)
    assert round_trips_lossless(ghl, text) is True
    assert round_trips_lossless(ghl, "\n".join(text.split("\n")[:-1])) is False  # dropped row
    assert round_trips_lossless(ghl, text.replace("Maria", "Mxria")) is False  # changed value
    assert round_trips_lossless(ghl, "not a block") is False

    # ── format parity with the JS golden test (same bytes) ────────────────────
    golden = [
        {"id": "c_001", "status": "won", "amount": 4200, "closed": True},
        {"id": "c_002", "status": "open", "amount": 0, "closed": False},
        {"id": "c_003", "status": "won", "amount": 980, "closed": True},
        {"id": "c_004", "status": "lost", "amount": 0, "closed": False},
        {"id": "c_005", "status": "won", "amount": 75, "closed": True},
    ]
    gtext = encode_table(golden)
    glines = gtext.split("\n")
    assert glines[0] == '##TBL keys=["id","status","amount","closed"] types=["s","s","n","b"] rows=5 enc=v1', glines[0]
    assert glines[1] == "c_001|won|4200|true"
    assert glines[5] == "c_005|won|75|true"
    assert json_equal(decode_table(gtext), golden)

    # ── json_equal: type-strict, order-insensitive ───────────────────────────
    assert json_equal({"a": 1, "b": 2}, {"b": 2, "a": 1}) is True
    assert json_equal([1, {"x": [2, 3]}], [1, {"x": [2, 3]}]) is True
    assert json_equal({"a": 1}, {"a": 1, "b": 2}) is False
    assert json_equal(1, "1") is False
    assert json_equal(True, 1) is False  # bool is NOT int here (kind-strict)
    assert json_equal(None, 0) is False

    # ── cache alignment ───────────────────────────────────────────────────────
    stable = ["SYSTEM POLICY", "SCHEMA: id,status", "TOOLS: [..]"]
    p1 = cache_align.assemble_prompt(stable=stable, volatile=["read A"])
    p2 = cache_align.assemble_prompt(stable=stable, volatile=["read B is different"])
    prefix = cache_align.cache_prefix(stable)
    assert p1.startswith(prefix) and p2.startswith(prefix)
    assert p1.endswith("read A") and p2.endswith("read B is different")
    assert cache_align.assemble_prompt(stable=["A"], volatile=[]) == "A"
    assert cache_align.assemble_prompt(stable=["A", "", None, "C"], volatile=["D"]) == "A\n\nC\n\nD"

    # ── constants ─────────────────────────────────────────────────────────────
    assert (MIN_ROWS, MIN_TOKENS, CORE_FIELD_FRACTION, HETEROGENEOUS_CORE_RATIO, ENC_VERSION) == (
        5, 200, 0.8, 0.6, 1)

    print("compaction.py smoke: OK")


if __name__ == "__main__":
    main()
