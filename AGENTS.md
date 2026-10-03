# Agents

Read **[`docs/vision.md`](docs/vision.md)** for the north star: who splitch is
for (agents first) and what "good" means (agent parity, enterprise scale,
statistical rigor, fail-loud, privacy). When a decision is ambiguous, resolve it
toward that document.

Read **`CONTEXT.md`** (repo root) next: the project glossary / ubiquitous
language. It adopts the Flagship and OpenFeature terms verbatim for the flag side
and the industry-standard experimentation terms (Statsig/Eppo/GrowthBook) for the
A/B side. Use these terms exactly; do not invent synonyms.

Before using the workflow skills, read **`docs/agents/workflow/config.md`**:
the repo's workflow lookup table (commands, Linear tracker IDs, labels, review
gates, environment safety).

In a fresh Git worktree, run `pnpm worktree:setup` before anything else. It
installs dependencies and git hooks and copies the gitignored `.env.local` from
the main checkout.

## Workflow skills

- `ziw-to-issues`: turn a spec, PRD, or epic into dependency-ordered
  `kind-slice` tickets
- `ziw-orchestrate`: the orchestration loop
- `ziw-implement`: take one startable issue through PR creation
- `ziw-triage`: current tracker cleanup and readiness repair (Backlog only on request)
- `ziw-code-review`: the shared review gate
- `ziw-pr`: PR creation

<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->
