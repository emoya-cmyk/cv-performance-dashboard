# Harness Charter — two floors, one design

The operating model for the emoya-cmyk ecosystem. There are **two harnesses**, and
keeping them distinct is the whole point. They share patterns; they are not the
same artifact.

| | **Dev-time harness** | **Run-time harness** |
|---|---|---|
| Governs | Claude Code building/operating the repos | Jarvis / `cli_framework` / dashboards acting in production |
| Lives in | `.claude/` + `shared-kit/claude/` | the product code (gates, ledgers, breakers) |
| Made of | CLAUDE.md, settings (permissions), hooks, subagents, skills, agent-memory | Wilson tiers, write-verification, circuit breakers, decision register |
| Makes better | the **builder** | the **product** |

> A great dev-time harness lets you *build* the run-time harness faster and safer.
> It is **not** a substitute for it — and neither raises the ceiling set by
> `cli_framework`. Do not let a polished `.claude/` folder masquerade as a sound
> Jarvis.

## The shared principles (apply to BOTH floors)

1. **Fail closed.** Default to refuse/deny/escalate. Autonomy is *granted*, never
   assumed. (Dev: `permissions.deny` + PreToolUse gate. Run: `ihAuth` 503 when a
   secret is unset; Tier 0 reviews every write.)
2. **Writer ≠ checker.** Never let the thing that did the work grade it. (Dev: the
   `reviewer` subagent, fresh context. Run: write-verification — *persistence is
   the writer's claim; VERIFIED_CORRECT is the checker's verdict*.)
3. **Earned, scoped autonomy.** Trust expands per scope on evidence, never
   globally. (Dev: auto-approve only cheap-to-undo ops. Run: Wilson lower bound on
   correctness promotes a single `(tenant, endpoint)` Tier 0 → 1 → 2.)
4. **Deterministic enforcement for must/never.** Use a gate that can't be
   hallucinated past, not a suggestion. (Dev: hooks exit 2. Run: DB CHECK
   constraints, circuit breakers, the fixed safe allow-list.)
5. **Irreversible → human.** (Both: `DECISION_REGISTER.md` gates identity, the
   verification schema, the promotion read path, and any teardown.)
6. **Memory compounds.** Every run leaves the next sharper. (Dev: `agent-memory/`
   state files distilled into skills. Run: memory-os + `grade_and_learn`.)

## The run-time harness, concretely (the three things to add)

1. **Policy layer = the guardrails you provide.** Operator-authored, not scattered
   constants: per-`(tenant, endpoint)` trust tiers, Wilson thresholds T1/T2,
   breaker trip conditions, the irreversible-action list, what needs approval.
2. **One enforcement seam.** A single `canActAutonomously(scope, action)` that
   composes every guard and returns *act / sample / escalate / refuse* — and fails
   closed. Today those checks are spread across modules; the harness makes them one
   chokepoint.
3. **An audit trail of every autonomous decision** against the guardrail that
   allowed or blocked it — so autonomy is always explainable after the fact.

## The trap

A harness can manufacture false confidence ("we have guardrails, so automate
everything"). That is the exact energy the correctness-first sequencing exists to
suppress. The harness is for *bounded, earned* autonomy — during uncertainty or a
drawdown a system at its best **does less, on purpose** (refuse-to-price, abstain,
escalate). Measure it by reliable output, not by how much it automates.

## Build order

1. Complete the **dev-time harness** (this PR seeds it: safety hook, reviewer
   subagent, state file; activation stays a human step per `settings.json.example`).
2. **Audit + harden `cli_framework`** (the keystone) against `CLI_FRAMEWORK_AUDIT.md`.
3. Wire the **run-time** seam: correctness → Wilson gate, behind the policy layer.
4. Widen autonomy **per scope, on earned correctness** — never globally.
5. **Consolidate to one hub** (`HUB_CONVERGENCE_PLAN.md`) so there is one harness
   to govern, not N drifting copies.
