# Environment Policy: configurable per-change-type Confirmation gates, not a hardcoded "prod is special"

**Status:** accepted

Given Environment as a first-class axis (ADR-0027) and Promotion (ADR-0028), this ADR pins **how splitch
makes production changes careful**. The requirement: changes to production must be **intentional** — a wrong
flag value or an accidental Experiment launch can break prod — but the user wants this **configurable**, not
imposed. Different users will want to gate different things: some want a Confirmation on _any_ prod change,
some only on Variant availability changes, some only on launching Experiment Runs.

**Each Environment has an Environment Policy: a per-change-type gate.** The Policy declares, for each change
type, whether the change is `allow` (commit freely), `confirm` (interpose a Confirmation), or `approve`
(future — a second principal's sign-off). The change types:

- **Variant availability** — promote a Variant into this Environment's available set.
- **Targeting / rollout / value** — change what is served and to whom.
- **Enabled state** — the kill switch.
- **Start an Experiment Run** — open a Run for measurement in this Environment.

A typical dev Policy is all-`allow` (edit freely, no friction). A prod Policy is the user's choice: confirm
on availability only, on value too, or on everything. The same **workflow** runs in every Environment — you
edit a flag or start a Run the same way everywhere — and only the **Policy** decides whether a Confirmation
is interposed before the commit. This is the user's "consistent workflow, different policies per
environment."

**Confirmation guards the commit, it does not stage the change.** A Confirmation is the intentionality step
("this affects production — proceed?"). It is **not** a draft and **not** optimistic state: once confirmed,
the change is live and per-change, exactly as an unguarded edit would be. The kill switch can **always** turn
a flag _off_ regardless of Policy — incident control is never gated.

**Why configurable Policy, not a hardcoded prod rule.** Hardcoding "prod requires confirmation" bakes one
team's risk tolerance into the product and has no clean answer for users with more than two environments or
unusual flows (a `canary` env stricter than `prod`, a `dev` that _is_ gated for a regulated team). A
per-Environment, per-change-type Policy makes "careful" a setting, and makes the safety **structural** (the
gate is enforced at the commit seam) rather than advisory.

## Considered options

- **Hardcoded "prod is special; prod changes require confirmation"** — rejected. Not configurable; assumes
  exactly two environments and one risk model; no home for per-change-type granularity (the user explicitly
  wants to gate availability vs. value vs. launch differently).
- **A single per-Environment boolean "require confirmation"** — rejected as too coarse. The user wants to
  confirm _some_ change types and not others in the same Environment; one boolean can't express "confirm
  availability changes but not value tweaks."
- **Full approval workflow (second-principal sign-off)** — deferred, not rejected. `approve` is
  reserved as a Policy _level_ above `confirm`, so adding multi-party approval later is an additive Policy
  value, not a new mechanism. Policy supports `allow` and `confirm` now.
- **Policy as client-side UI gating only** — rejected. The gate must be enforced at the control-plane commit
  seam (server-side), or the CLI/MCP/agent surfaces bypass it. Policy is enforced where the write happens,
  the UI merely reflects it.

## Consequences

- **Each Environment carries an Environment Policy** — a map from change type to `allow | confirm`
  (`| approve`, future). Stored per Environment, enforced server-side at the commit seam for _all_ surfaces
  (panel, CLI, MCP, agent).
- **The control plane gains a Confirmation step** surfaced consistently across change types; the panel
  renders it as a confirm dialog, the CLI/MCP as an explicit confirm flag/step (agent-friendly).
- **The kill-switch-off exemption is a hard rule**, independent of Policy.
- **CONTEXT.md** gains Environment Policy and Confirmation.
- **The "what is production" open question from flag-editing-ux.md is resolved**: production is an
  Environment, and "careful" is its Policy — not a global hardcoded check.
- **CLI/MCP parity (ADR-0023) must carry Policy** — a `confirm`-level change over CLI/MCP requires an
  explicit confirm step so an agent cannot silently bypass a prod gate.
