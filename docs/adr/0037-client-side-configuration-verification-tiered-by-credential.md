# Client-side configuration verification, tiered by credential

**Status:** accepted

Setting splitch up should end with a green check, not a leap of faith. A developer or agent
that has just created a Flag and copied a Client Key needs to confirm, **from where their code
runs and with the credential their code holds**, that everything is wired correctly — without
deploying a real user into a Run and without leaking the experiment design. splitch ships a
**verification path on every credential tier**, and what it reveals scales with how trusted
the credential is. The public tier proves reachability and configured-ness; the trusted tiers
reveal the full resolution reason.

This extends [ADR-0026](0026-test-evaluation-endpoint-dry-run-never-exposes.md) (which put the
reason-revealing dry-run behind the control-plane token) rather than replacing it: ADR-0026's
control-plane debugger is unchanged and remains the richest tier. This ADR adds the two lower
tiers so verification is possible _with the SDK's own credential_, closing the "I have a key,
now what?" gap.

## The three tiers (least to most revealing)

| Tier             | Credential          | Endpoint                   | Reveals                                                                                                          | Exposure |
| ---------------- | ------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------- | -------- |
| Client (public)  | Client Key          | `POST /apps/:appId/verify` | Reachable, credential valid, Flag exists & configured, resolves OK; `reason` from the **non-revealing** set only | none     |
| Server (trusted) | API Key             | peek / `verify` w/ API Key | Full `ResolutionDetails` incl. `TARGETING_MATCH` + which rule matched                                            | none     |
| Control plane    | control-plane token | test-eval (ADR-0026)       | Everything: rule match, allocation reasoning, `liveRunId`                                                        | none     |

All three are **non-exposing by construction** (ADR-0004/0026): verification is not a real
Entity encountering its Variant. None writes an Exposure log row or Assignment Store entry.

## The public tier reveals nothing reverse-engineerable (ADR-0018 preserved)

The public `verify` path answers exactly: _can this Client Key reach this App, does this Flag
exist and have a Configuration in the Client Key's Environment, and does an evaluation succeed?_
It returns the resolved Variant **value** (already public via `evaluate`, ADR-0018) plus a
`reason` drawn only from the non-revealing set defined in
[ADR-0036](0036-evaluation-is-fail-loud-no-silent-fallback-openfeature-resolution-details.md)
(`SPLIT`, `DEFAULT`, `DISABLED`, `CACHED`, `STALE`, `ERROR`). It **never** names which
Targeting Rule matched, never returns allocation fractions, never returns the salt — the same
hard constraints as the public evaluate endpoint. Verifying must not become the allocation
oracle ADR-0034 closes, so the public `verify` is rate-limited and origin-bound exactly like
`evaluate`, and like `peekVariant` it is **not** a silent allocation oracle because it carries
no richer information than `evaluate` already does.

The difference from `evaluate` is purpose and side effect, not disclosure: `verify` fires no
Exposure and is explicitly the "is my setup correct" call, so an agent or a dev can loop it
during setup without polluting analysis.

## Fail-loud applies (ADR-0036)

`verify` uses the same `ResolutionDetails` shape and the same fail-loud rule: a failure to
reach config returns `reason: ERROR` + `errorCode`, loudly. A green verify is an unambiguous
`reason` in the success set; there is no silent "looks fine" that was actually a fallback.

## Considered options

- **Only the control-plane dry-run (ADR-0026 as-is)** — rejected: it requires a control-plane
  token, so deployed SDK code and the credential the dev actually pasted cannot self-verify.
  The setup loop ("paste key → confirm it works") is the highest-friction onboarding moment;
  it must work with the Client Key.
- **Let the public tier reveal the resolution reason for parity with the debugger** — rejected:
  that hands the experiment design to anyone holding the public key (ADR-0018). Disclosure is
  tiered by credential trust, full stop.
- **Reuse `evaluate` as the verify call** — rejected: `evaluate` fires an Exposure (ADR-0004),
  so a setup loop would inject phantom Exposures. Verification must be structurally
  non-exposing, like peek and the dry-run.

## Consequences

- One new data-plane endpoint (`POST /api/sdk/verify`, Client Key or API Key). Like
  `/api/sdk/evaluate`, it is **not** an MCP tool (data-plane endpoints are called by SDK clients,
  not agents) — it surfaces in the CLI as `splitch flags verify` for developers testing with the
  credential their code holds. The agent's verification path stays the control-plane
  `flags_test_eval` (the richest tier, ADR-0026).
- The SDK gains a `verify(flagKey, context)` accessor returning `ResolutionDetails` (public
  reason set under a Client Key, full detail under an API Key). It is the in-product
  "is it configured?" call the onboarding quickstart surfaces.
- The visual onboarding and the agent flow both end on a real `verify` round-trip, so
  time-to-first-confidence is one call, on any tier.

## Sources

- [ADR-0004](0004-exposure-fires-on-read.md) — verification is structurally non-exposing
- [ADR-0018](0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md) — public key never reveals rules/allocation
- [ADR-0026](0026-test-evaluation-endpoint-dry-run-never-exposes.md) — control-plane reason-revealing dry-run (the richest tier; extended here)
- [ADR-0034](0034-edge-abuse-controls-are-a-cloudflare-enforced-product-contract.md) — verify is rate-limited/origin-bound like evaluate
- [ADR-0036](0036-evaluation-is-fail-loud-no-silent-fallback-openfeature-resolution-details.md) — shared ResolutionDetails + non-revealing reason set
