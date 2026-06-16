#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Claude Code SessionStart hook — shared baseline.
#
# Makes a freshly-cloned web/remote session immediately able to run this repo's
# checks: it installs dependencies (INCLUDING devDependencies — `--include=dev`
# dodges any committed `.npmrc` with production=true) wherever a package-lock.json
# lives. Idempotent (skips dirs that already have node_modules) and best-effort:
# it never fails the session.
#
# Install: drop this at .claude/session-start.sh (chmod +x) and wire it in
# .claude/settings.json (see settings.json in this kit).
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

install_dir() {
  local dir="$1"
  [ -f "$dir/package-lock.json" ] || return 0
  [ -d "$dir/node_modules" ] && return 0
  echo "[session-start] installing deps in ${dir:-.}"
  ( cd "$dir" && npm ci --include=dev ) \
    || echo "[session-start] npm ci failed in '$dir' (continuing)"
}

# Common layouts: repo root and a conventional api/ backend. Add dirs as needed.
install_dir "."
install_dir "api"

exit 0
