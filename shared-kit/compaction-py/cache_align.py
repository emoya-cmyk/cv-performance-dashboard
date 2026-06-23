"""cache_align.py — prompt-prefix CACHE ALIGNMENT (Python twin of cacheAlign.js).

Not a transform — a call-site DISCIPLINE captured as one tiny helper so every repo
assembles prompts the same way. Provider caches (Anthropic, OpenAI) bill cached
input tokens at a steep discount but only hit on a byte-IDENTICAL PREFIX. So put
everything STABLE across requests first (system policy, schema, tool defs, fixed
instructions) and byte-invariant, and append the VOLATILE per-request payload (the
compacted read from compaction.py) LAST. The stable prefix then caches once and is
reused on every call. Pure string assembly — no data changes, nothing is dropped;
the only token effect is moving spend from full-price to cached-price. Zero deps.
"""

DEFAULT_SEPARATOR = "\n\n"


def _join_parts(parts, separator):
    if isinstance(parts, str):
        parts = [parts]
    return separator.join(p for p in parts if isinstance(p, str) and p)


def cache_prefix(stable, separator=DEFAULT_SEPARATOR):
    """The stable, cacheable prefix — exactly the bytes a provider cache keys on.
    Keep it identical across requests for the cache to hit."""
    return _join_parts(stable, separator)


def assemble_prompt(stable=None, volatile=None, separator=DEFAULT_SEPARATOR):
    """Stable prefix first (cacheable), volatile suffix last. Returns the string to
    send to the model."""
    prefix = cache_prefix(stable or [], separator)
    suffix = _join_parts(volatile or [], separator)
    if not prefix:
        return suffix
    if not suffix:
        return prefix
    return prefix + separator + suffix
