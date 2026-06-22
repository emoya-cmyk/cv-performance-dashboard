"""compaction.py — LOSSLESS tabular compaction (Python port).

Byte-for-byte format twin of shared-kit/compaction (JS): an ``enc=v1`` block
written by either language decodes in the other. The single most compressible
shape we send a model is an array of near-uniform JSON objects, because the field
NAMES repeat on every row; this reformats such an array into one schema header +
one delimited line per row so each key is named once. Every VALUE survives — a
bijection on the value set: ``expand(compact(x)["text"]) == x`` for all inputs.
That fidelity is the point: nothing is dropped, substituted, or reordered, so any
count/sum/lookup the model performs is over the complete, unaltered set — exactly
what the family's grounded-AI invariant requires.

Out of scope here, on purpose (family-wide): no row-drop/truncation, no opaque
value substitution, no reversible-offload/TTL retrieval, no external service. If a
transform can't be proven lossless for an input, the input PASSES THROUGH
untouched. Conservative by construction. Never guess.

PURE: no DB, no clock, no network. Standard library only (``json``) — zero deps.

Provenance: the array-of-objects -> schema+rows idea is inspired by
chopratejas/headroom (Apache-2.0); this is a clean-room re-implementation of only
that one lossless primitive (see NOTICE). The lossy paths Headroom also offers
(row-drop, CCR offload) are intentionally NOT carried here.
"""
import json
import math

# ── tuning constants (the §3.3 / D-3 defaults; all overridable per call) ──────
MIN_ROWS = 5
MIN_TOKENS = 200
CORE_FIELD_FRACTION = 0.8
HETEROGENEOUS_CORE_RATIO = 0.6
ENC_VERSION = 1
TOKENS_PER_CHAR = 0.25  # ~4 chars/token — estimate ONLY for the eligibility gate

DELIM = "|"
ABSENT = "\\z"  # a whole cell equal to this means "row did not have this key"


def _dumps(v):
    """JSON like JS ``JSON.stringify``: no spaces, raw unicode. Keeps char counts
    and the on-the-wire format aligned with the JS twin."""
    return json.dumps(v, separators=(",", ":"), ensure_ascii=False)


# ── reversible escaping ───────────────────────────────────────────────────────
def escape_cell(s):
    return (
        str(s)
        .replace("\\", "\\\\")
        .replace("|", "\\|")
        .replace("\n", "\\n")
        .replace("\r", "\\r")
    )


def unescape_cell(s):
    out = []
    i = 0
    n = len(s)
    while i < n:
        c = s[i]
        if c == "\\" and i + 1 < n:
            nxt = s[i + 1]
            i += 2
            if nxt == "\\":
                out.append("\\")
            elif nxt == "|":
                out.append("|")
            elif nxt == "n":
                out.append("\n")
            elif nxt == "r":
                out.append("\r")
            else:
                out.append(nxt)  # not produced by escape_cell; defensive passthrough
        else:
            out.append(c)
            i += 1
    return "".join(out)


def split_cells(line):
    """Split a row on UNESCAPED delimiters; keep trailing empties."""
    cells = []
    cur = []
    i = 0
    n = len(line)
    while i < n:
        c = line[i]
        if c == "\\" and i + 1 < n:
            cur.append(c)
            cur.append(line[i + 1])
            i += 2
        elif c == DELIM:
            cells.append("".join(cur))
            cur = []
            i += 1
        else:
            cur.append(c)
            i += 1
    cells.append("".join(cur))
    return cells


# ── value classification ──────────────────────────────────────────────────────
def kind_of(v):
    if v is None:
        return "null"
    if isinstance(v, bool):  # MUST precede int — bool is a subclass of int
        return "boolean"
    if isinstance(v, str):
        return "string"
    if isinstance(v, (int, float)):
        return "number"
    if isinstance(v, (dict, list)):
        return "json"
    return "unsupported"


def col_type(values):
    """Storage type over the rows that HAVE the key:
    's' all strings · 'n' all numbers · 'b' all booleans · 'x' anything else."""
    kinds = set()
    for present, value in values:
        if not present:
            continue
        kinds.add(kind_of(value))
    if len(kinds) == 1:
        (only,) = tuple(kinds)
        if only == "string":
            return "s"
        if only == "number":
            return "n"
        if only == "boolean":
            return "b"
    return "x"


# ── per-cell encode / decode ──────────────────────────────────────────────────
def encode_cell(value, present, type_):
    if not present:
        return ABSENT
    if type_ == "s":
        return escape_cell(value)
    if type_ == "n":
        return _dumps(value)
    if type_ == "b":
        return "true" if value else "false"
    # 'x' — tag every cell so decode rebuilds the exact type.
    k = kind_of(value)
    if k == "null":
        return "~"
    if k == "string":
        return "s:" + escape_cell(value)
    if k == "number":
        return "n:" + _dumps(value)
    if k == "boolean":
        return "b:" + ("t" if value else "f")
    return "j:" + escape_cell(_dumps(value))


_ABSENT_MARKER = object()


def decode_cell(cell, type_):
    """Returns the value, or ``_ABSENT_MARKER`` if the key was absent on this row."""
    if cell == ABSENT:
        return _ABSENT_MARKER
    if type_ == "s":
        return unescape_cell(cell)
    if type_ == "n":
        return json.loads(cell)
    if type_ == "b":
        return cell == "true"
    if cell == "~":
        return None
    tag = cell[:2]
    rest = cell[2:]
    if tag == "s:":
        return unescape_cell(rest)
    if tag == "n:":
        return json.loads(rest)
    if tag == "b:":
        return rest == "t"
    if tag == "j:":
        return json.loads(unescape_cell(rest))
    return cell  # unknown tag → raw; verify() catches any resulting mismatch


# ── the table codec ───────────────────────────────────────────────────────────
def encode_table(rows):
    keys = []
    seen = set()
    for row in rows:
        for k in row.keys():
            if k not in seen:
                seen.add(k)
                keys.append(k)
    types = [
        col_type([(k in row, row.get(k)) for row in rows]) for k in keys
    ]
    header = "##TBL keys=%s types=%s rows=%d enc=v%d" % (
        _dumps(keys),
        _dumps(types),
        len(rows),
        ENC_VERSION,
    )
    body = [
        DELIM.join(encode_cell(row.get(k), k in row, types[i]) for i, k in enumerate(keys))
        for row in rows
    ]
    return "\n".join([header] + body)


_HEADER_RE = None


def _parse_header(line):
    import re

    global _HEADER_RE
    if _HEADER_RE is None:
        _HEADER_RE = re.compile(r"^##TBL keys=(\[.*?\]) types=(\[.*?\]) rows=(\d+) enc=v(\d+)$")
    m = _HEADER_RE.match(line)
    if not m:
        return None
    try:
        keys = json.loads(m.group(1))
        types = json.loads(m.group(2))
    except ValueError:
        return None
    return {"keys": keys, "types": types, "rows": int(m.group(3)), "enc": int(m.group(4))}


def decode_table(text):
    lines = text.split("\n")
    head = _parse_header(lines[0])
    if not head:
        raise ValueError("compaction: not a ##TBL block")
    keys = head["keys"]
    types = head["types"]
    out = []
    for line in lines[1:]:
        cells = split_cells(line)
        obj = {}
        for j, key in enumerate(keys):
            val = decode_cell(cells[j], types[j])
            if val is not _ABSENT_MARKER:
                obj[key] = val
        out.append(obj)
    return out


# ── structural equality over JSON-shaped data (type-strict, order-insensitive) ─
def json_equal(a, b):
    ka, kb = kind_of(a), kind_of(b)
    if ka != kb:
        return False
    if ka == "json":
        if isinstance(a, list):
            if not isinstance(b, list) or len(a) != len(b):
                return False
            return all(json_equal(x, y) for x, y in zip(a, b))
        if not isinstance(b, dict) or set(a.keys()) != set(b.keys()):
            return False
        return all(json_equal(a[k], b[k]) for k in a.keys())
    return a == b


def round_trips_lossless(value, text):
    """The fidelity predicate the verify guard is built on."""
    try:
        decoded = decode_table(text)
    except (ValueError, KeyError, IndexError):
        return False
    return json_equal(decoded, value)


# ── eligibility ───────────────────────────────────────────────────────────────
def is_array_of_objects(v):
    if not isinstance(v, list) or len(v) == 0:
        return False
    return all(isinstance(el, dict) for el in v)


def estimate_tokens(s):
    return math.ceil(len(s) * TOKENS_PER_CHAR)


# ── the public transform ──────────────────────────────────────────────────────
def compact(
    value,
    min_rows=MIN_ROWS,
    min_tokens=MIN_TOKENS,
    core_field_fraction=CORE_FIELD_FRACTION,
    heterogeneous_core_ratio=HETEROGENEOUS_CORE_RATIO,
    verify=True,
):
    """Returns a dict: ``compacted`` (bool), ``text`` (always model-ready: the
    block, or raw JSON), ``reason``, and measured/estimated sizes. ``verify=True``
    round-trips inline and falls back to the original on ANY mismatch — we would
    rather send more tokens than a single altered value."""
    original = _dumps(value)
    base = {
        "compacted": False,
        "text": original,
        "original_chars": len(original),
        "compacted_chars": len(original),
        "ratio": 1.0,
        "original_tokens_est": estimate_tokens(original),
        "compacted_tokens_est": estimate_tokens(original),
    }

    if not is_array_of_objects(value):
        return dict(base, reason="not-array-of-objects")
    if len(value) < min_rows:
        return dict(base, reason="below-min-rows")
    if estimate_tokens(original) < min_tokens:
        return dict(base, reason="below-min-tokens")

    presence = {}
    for row in value:
        for k in row.keys():
            presence[k] = presence.get(k, 0) + 1
    if not presence:
        return dict(base, reason="no-keys")
    core_keys = sum(1 for n in presence.values() if n / len(value) >= core_field_fraction)
    core_share = core_keys / len(presence)
    if core_share < heterogeneous_core_ratio:
        # Too ragged for a clean single table — v1 stays lossless by passing the
        # original through rather than guessing a discriminator (v2 deferral).
        return dict(base, reason="heterogeneous")

    text = encode_table(value)

    if verify and not round_trips_lossless(value, text):
        return dict(base, reason="verify-failed-fallback")

    if len(text) >= len(original):
        return dict(base, reason="no-gain")

    return {
        "compacted": True,
        "text": text,
        "reason": "compacted",
        "original_chars": len(original),
        "compacted_chars": len(text),
        "ratio": len(text) / len(original),
        "original_tokens_est": estimate_tokens(original),
        "compacted_tokens_est": estimate_tokens(text),
    }


def expand(text):
    """Exact inverse of ``compact``: a ``##TBL`` block -> array, else ``json.loads``."""
    if isinstance(text, str) and text.startswith("##TBL"):
        return decode_table(text)
    return json.loads(text)
