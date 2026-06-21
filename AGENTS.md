# Agents

Read **`CONTEXT.md`** (repo root) first — the project glossary / ubiquitous
language. It adopts the Flagship and OpenFeature terms verbatim for the flag side
and the industry-standard experimentation terms (Statsig/Eppo/GrowthBook) for the
A/B side. Use these terms exactly; do not invent synonyms.

Before using the workflow skills, read **`docs/agents/workflow/config.md`** —
the repo's workflow lookup table (commands, Linear tracker IDs, labels, review
gates, environment safety).

## Workflow skills

- `ziw-to-issues` — turn a spec, PRD, or epic into dependency-ordered
  `kind-slice` tickets
- `ziw-orchestrate` — the orchestration loop
- `ziw-implement` — take one startable issue through PR creation
- `ziw-review` — independent review of the latest committed PR head and main drift
- `ziw-triage` — current tracker cleanup and readiness repair (Backlog only on request)
- `ziw-code-review` — the shared review gate
- `ziw-pr` — PR creation
