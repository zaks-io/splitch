# Remote Worker Review

Use this when the user asks for a remote worker agent to review a branch or PR.

## Start Options

- Use the repo-configured remote worker provider from
  `docs/agents/workflow/config.md`.
- Resolve the target first with `node scripts/resolve-review-target.mjs`; the
  remote worker inherits that head SHA and never resolves its own.
- Launch a review-only run pinned to the resolved head SHA.
- Set auto-PR creation off when the provider supports that option.
- Paste the prompt below.
- Do not print, store, or commit provider API keys.

For remote review, assume hosted secrets are opt-in per issue. Default to local
checks only unless the prompt explicitly authorizes preview or production
credentials.

## Prompt Template

```text
Code review only. Do not edit files, commit, push, or open a PR.

Repo: <owner/name>
PR: #<number or "none">
Head SHA: <resolved head sha, review this revision only>
Base: <base branch>

Do not resolve a target from the checked-out branch or any ambient state; review
the head SHA above and report it in your output.

Read first:
- AGENTS.md or CLAUDE.md
- docs/agents/workflow/config.md if present
- docs/agents/remote-worker-agent.md or provider adapter docs if present
- CONTEXT.md if present
- docs/specs/README.md and docs/adr/README.md if present
- Any repo-local skills relevant to touched files

Review the diff against the base branch for correctness, security, data loss, race conditions, API/schema contract drift, missing enum/status handling, missing tests, and scope drift. Scope drift includes delivering adjacent tickets, optional polish, broad refactors, or new surfaces outside the issue boundary. Run focused checks if cheap. Do not call hosted bot review providers such as CodeRabbit or Cursor Bugbot from this worker.

Use this review rubric:
- Verify every finding with file:line evidence.
- Prioritize P0/P1 correctness, security, auth, data-loss, migration, concurrency, and API-contract issues.
- Treat config/numeric limit changes as high-risk until justified by production bounds, rollback, and monitoring.
- Suppress style nits, low-confidence speculation, broad refactors, and optional micro-optimizations.

Return only:
- Scope check: clean, drift, or missing requirements
- Findings table with severity, confidence, file:line, evidence, impact, and suggested fix
- Checks run
- Hosted bot review recommendation: skip, CLI, or PR review; include provider
  and auto-review mode
  and command or skip marker when known
- Verdict: ready, needs revision, or do not merge
```
