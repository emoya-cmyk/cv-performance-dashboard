#!/usr/bin/env python3
"""
check_vendor_drift.py
=====================
Family-wide drift guard for the vendored shared-kit modules. This is the
automated check that was missing — dashboard-core had silently drifted across
THREE repos (0.1 / 0.2 / 0.4) and only a manual diff caught it. Run this in a
scheduled job (or the eventual org-repo CI) so "the playbook says ✅" is something
a machine proves, not something a human assumes.

Compares each consumer's vendored copy against the canonical shared-kit source:
  * dashboard-core  -> cv/agency/performance  api/vendor/dashboard-core
  * memory-os-py    -> cli_framework          enhancements/vendor/memory_os

Exit 0 = everything in sync; exit 1 = drift found (details printed).

Usage:
    python3 shared-kit/scripts/check_vendor_drift.py            # auto-detect sibling repos
    python3 shared-kit/scripts/check_vendor_drift.py --root /path/to/repos
"""

import argparse
import sys
from pathlib import Path

_SHARED = Path(__file__).resolve().parents[1]          # .../<cv>/shared-kit
_CV = _SHARED.parent                                    # the cv repo
_DEFAULT_ROOT = _CV.parent                              # dir holding the sibling repos

# target: (canonical subdir, consumer repo, consumer vendor subpath,
#          canonical-only files that are NOT vendored, consumer-only files that are OK)
_TARGETS = [
    ("dashboard-core", "cv-performance-dashboard", "api/vendor/dashboard-core",
     {"package-lock.json"}, {"PROVENANCE.md"}),
    ("dashboard-core", "agency-performance-dashboard", "api/vendor/dashboard-core",
     {"package-lock.json"}, {"PROVENANCE.md"}),
    ("dashboard-core", "performance-dashboard", "api/vendor/dashboard-core",
     {"package-lock.json"}, {"PROVENANCE.md"}),
    ("memory-os-py", "cli_framework", "enhancements/vendor/memory_os",
     # README is intentionally adapted for the vendored copy (PROVENANCE lists only
     # memory_os.py + schema*.sql as byte-identical); pyproject/smoke aren't vendored.
     {"pyproject.toml", "test_smoke.py", "README.md"}, {"PROVENANCE.md", "__init__.py"}),
    ("compaction-py", "cli_framework", "enhancements/vendor/compaction",
     # compaction.py + cache_align.py + NOTICE are byte-identical; the kit's README/
     # pyproject/tests aren't vendored, and the vendor adds __init__ + PROVENANCE.
     {"pyproject.toml", "README.md", "tests/test_smoke.py"}, {"PROVENANCE.md", "__init__.py"}),
    ("compaction", "agency-performance-dashboard", "api/vendor/compaction",
     # JS module vendored whole (index.js, lib/, package.json, README, NOTICE, test/);
     # the only vendor-side extra is PROVENANCE.md. (cv's copy is guarded in-repo by
     # api/test/vendorSyncCompaction.test.js.)
     set(), {"PROVENANCE.md"}),
]


def _walk(root):
    out = {}
    if not root.exists():
        return out
    for p in root.rglob("*"):
        if not p.is_file():
            continue
        rel = str(p.relative_to(root))
        # Ignore Python bytecode / build artifacts — never vendored source.
        if "__pycache__" in p.parts or p.suffix == ".pyc":
            continue
        out[rel] = p
    return out


def _compare(canonical, vendor, canon_skip, vendor_skip):
    can = _walk(canonical)
    ven = _walk(vendor)
    missing = sorted(r for r in can if r not in canon_skip and r not in ven)
    differ = sorted(r for r in can
                    if r not in canon_skip and r in ven
                    and can[r].read_bytes() != ven[r].read_bytes())
    extra = sorted(r for r in ven if r not in vendor_skip and r not in can)
    return missing, differ, extra


def main(argv=None):
    ap = argparse.ArgumentParser(description="Check vendored shared-kit modules for drift")
    ap.add_argument("--root", default=str(_DEFAULT_ROOT),
                    help="dir containing the sibling repos (default: cv's parent)")
    args = ap.parse_args(argv)
    root = Path(args.root)

    drift = False
    print(f"vendor drift check — canonical: {_SHARED}\n")
    for canon_name, repo, vendor_sub, canon_skip, vendor_skip in _TARGETS:
        canonical = _SHARED / canon_name
        vendor = root / repo / vendor_sub
        label = f"{repo}:{vendor_sub}"
        if not canonical.exists():
            print(f"  ??  {label}  (canonical {canon_name} missing — skipped)")
            continue
        if not vendor.exists():
            print(f"  ??  {label}  (consumer not found at {vendor} — skipped)")
            continue
        missing, differ, extra = _compare(canonical, vendor, canon_skip, vendor_skip)
        if not (missing or differ or extra):
            print(f"  OK  {label}")
            continue
        drift = True
        print(f"  XX  {label}  DRIFT")
        for r in differ:
            print(f"        differs:  {r}")
        for r in missing:
            print(f"        missing:  {r}")
        for r in extra:
            print(f"        extra:    {r}")

    print("\n" + ("DRIFT FOUND — re-sync from shared-kit." if drift else "All vendored copies in sync."))
    return 1 if drift else 0


if __name__ == "__main__":
    sys.exit(main())
