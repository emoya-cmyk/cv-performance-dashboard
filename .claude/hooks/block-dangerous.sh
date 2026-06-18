#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# PreToolUse safety gate (harness step 9) — DETERMINISTIC, the model can't talk
# past it. Reads the Claude Code hook JSON on stdin; exit 2 BLOCKS the tool call
# before it runs. Pairs with the declarative permissions.deny in settings.json
# (belt + suspenders): deny handles file globs, this handles command nuance the
# globs can't express (push to a protected branch, broad recursive deletes).
#
# Install: ship at .claude/hooks/block-dangerous.sh (chmod +x) and wire a
# PreToolUse "Bash" hook to it in .claude/settings.json (see settings.json.example).
# Keep it SHARP — one or two real rules, not twenty (harness anti-pattern §).
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

input="$(cat)"
# Parse the command (Bash) or file_path (Edit/Write) out of the hook payload with
# node — guaranteed present in these repos, and robust to JSON escaping.
target="$(printf '%s' "$input" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);const t=j.tool_input||{};process.stdout.write(String(t.command||t.file_path||""))}catch{process.stdout.write("")}})' 2>/dev/null || true)"

block() { echo "BLOCKED by harness safety gate: $1" >&2; exit 2; }

# Never force-push (rewrites shared history irreversibly).
printf '%s' "$target" | grep -Eq 'git[[:space:]]+push([[:space:]]|.)*(--force([[:space:]]|=|$)|-f([[:space:]]|$))' && block "force-push"
# Never push directly to a protected branch.
printf '%s' "$target" | grep -Eq 'git[[:space:]]+push.*[[:space:]](main|master)([[:space:]]|$)' && block "push to a protected branch (main/master)"
# Never recursive-delete an absolute or home path (catches /, /etc, /var, ~, $HOME, …).
printf '%s' "$target" | grep -Eq 'rm[[:space:]]+-[a-zA-Z]*r[a-zA-Z]*[[:space:]]+(-[a-zA-Z]+[[:space:]]+)*(/|~|\$HOME)' && block "recursive delete of an absolute / home path"
# Never read/edit a secret or credential.
printf '%s' "$target" | grep -Eq '(^|[[:space:]/="'"'"'])\.env([.[:space:]"'"'"']|$)|(^|/)secrets/|id_rsa|\.pem([[:space:]"'"'"']|$)' && block "secret / credential file"

exit 0
