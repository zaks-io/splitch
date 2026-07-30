# MCP discovery: prompts and resources over the derived tools

The derived tools (one per endpoint, [mcp-tool-derivation.md](../contracts/mcp-tool-derivation.md))
give an agent the full capability surface, but a flat list of ~40 typed tools does not tell an
agent **where to start**, **what order things go in**, or **what the nouns mean**. An agent
landing on splitch cold should not have to infer the first-run sequence from tool schemas or read
the docs site. This layer closes that: MCP **prompts** carry the canonical workflows, MCP
**resources** carry the read-only context (glossary, auth, the agent's own active scope).

This is the biggest agent-experience lever, and it is **not** derived from Zod routes — like
`context_use` (see [mcp-and-cli-surfaces.md](./mcp-and-cli-surfaces.md)), prompts and resources are
MCP-protocol capabilities the server exposes directly, not endpoint skins. They orchestrate the
derived tools; they never replace or duplicate them.

## Design rule: discovery guides, tools act

- **Prompts and resources never mutate.** A prompt returns a message sequence (a plan the agent
  executes via tools); a resource returns read-only text/JSON. The only thing that changes state
  is a derived tool call, which still goes through the Worker's full validation (ADR-0023). This
  keeps the "invariants live in the Worker, not the skins" guarantee intact.
- **No second source of truth.** A prompt references tools by their canonical `operationId`
  (`flags_create`, `experiments_start`) and nouns by their CONTEXT.md glossary term. It does not
  restate request schemas (the tool's derived `inputSchema` is authoritative) and does not restate
  the glossary (the `splitch://context` resource is authoritative). A prompt that drifts from a
  tool name is a contract error caught the same way a bad `operationId` is.
- **Parity-shaped.** Each prompt maps 1:1 to the onboarding step sequence the control panel and the
  CLI quickstart surface ([../frontend/screen-inventory.md](../frontend/screen-inventory.md)) —
  the agent path and the human path are the same steps, different skins (ADR-0023).

## MCP prompts (guided workflows)

Prompts are the "how do I…" layer. Each is a named, parameterized template that returns a short
message sequence naming the exact derived tools to call, in order, with the active-context and
verify steps built in. The agent gets a plan, then executes it with tools.

| Prompt               | Arguments                          | Returns a plan that…                                                                                                                                  |
| -------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `onboard_new_app`    | `orgId`, `appName`                 | `apps_create` (provisions dev+prod Envs) → `context_use` (select dev) → `client_key_get` → `flags_create` → `flags_verify` round-trip → confirm green |
| `ship_a_flag`        | `flagKey`, `variants`              | `flags_create` (App-level) → `flags_promote` into the active Env → `flags_test_eval` to confirm the rule set resolves                                 |
| `run_an_experiment`  | `flagId`, `variants`, `allocation` | `experiments_create` → `experiments_start` → `flags_test_eval` to confirm the live Run resolves → poll `experiment_results_get`                       |
| `end_a_run`          | `runId`                            | `flags_test_eval` (capture current resolution) → `runs_end` → confirm `RUN_NOT_RUNNING` is now the state                                              |
| `recover_from_error` | `errorCode`, `details`             | reads `details.recommendedAction` and emits the remediation step sequence (see Recovery below)                                                        |
| `diagnose_setup`     | (none; uses active context)        | `context` (resolve active app/env + source) → `client_key_get` → `flags_verify` on a known flag → report what is and isn't wired                      |

Notes:

- An agent with no `orgId` in hand calls `organizations_list` first to discover the Organizations
  its token can reach, then feeds the chosen one to `onboard_new_app` (cold-start entry point).
- If the session authenticated via the **anonymous door**, the Org is a 24h demo
  (`splitch://active-context` carries `demoExpiresAt`). The `onboard_new_app` plan ends by telling
  the human to claim the account before it expires.
- Verify proves **wiring**; the **first real `evaluate`** proves the integration. The plan's final
  message tells the agent onboarding is complete only at the first real Exposure (deploy → call
  `evaluate` with a real Targeting Key → dashboard flips to "first Exposure received").
- Every workflow prompt **ends on a real `verify` / `test_eval` round-trip**, so the agent's
  time-to-first-confidence is one call, on any tier (ADR-0037). A prompt never ends on "probably
  fine."
- `onboard_new_app` uses the **data-plane** `flags_verify` step via the CLI/SDK credential path
  (the Client Key it just fetched), because that is the credential the customer's code will hold;
  the deeper `flags_test_eval` (control-plane, full reason) is used where rule identity matters.
  This mirrors the tiered verification in ADR-0037.
- Prompts are advisory plans, not transactions. The agent may deviate; the Worker is still the
  guardian. A prompt that suggests `experiments_start` does not pre-authorize it — the Start still
  goes through Environment Policy confirmation (ADR-0029).

## MCP resources (read-only context)

Resources are the "what does this mean / what is my situation" layer. They are addressable,
cacheable, read-only, and carry no side effects.

| Resource URI               | MIME             | Content                                                                                                                                                                                                                                                                 |
| -------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `splitch://context`        | text/markdown    | The CONTEXT.md ubiquitous-language glossary (Flag, Variant, Run, Exposure, Targeting Key, …). One source.                                                                                                                                                               |
| `splitch://auth`           | text/markdown    | The `auth.md` companion: the three identity doors, how the agent authenticated, how to widen scope (ADR-0022).                                                                                                                                                          |
| `splitch://active-context` | application/json | The resolved active `{ app, environment, source }` for this session — the same data `context` returns. Includes `demoExpiresAt` (ISO 8601) when the Org is a provisional anon-door demo, so the agent can see the 24h deadline and prompt the human to claim before it. |
| `splitch://capabilities`   | application/json | The token's scopes + which tools they gate, so the agent knows up front what it can and cannot do.                                                                                                                                                                      |
| `splitch://quickstart`     | text/markdown    | The agent-first quickstart: transports [../quickstart.md](../quickstart.md) verbatim — the canonical first-run narrative the `onboard_new_app` prompt automates.                                                                                                        |

Notes:

- `splitch://context` and `splitch://auth` are the **same files** the human-readable docs surface
  (CONTEXT.md, auth.md) — the resource is a transport of the canonical file, not a paraphrase. No
  glossary drift between what a human reads and what an agent reads.
- `splitch://active-context` and `splitch://capabilities` are **session-scoped**: they reflect the
  transport session's active App/Environment and token scopes (set via `context_use`, carried in
  the session, never persisted server-side, never widening scope —
  [mcp-and-cli-surfaces.md](./mcp-and-cli-surfaces.md)).
- Resources are read-only by protocol; an agent reading `splitch://capabilities` to plan before
  acting cannot change anything by reading it.

## Recovery prompt: closing the error → next-step loop

`recover_from_error` is the bridge between the error contract and the discovery layer. When a tool
call returns an operational `409`, the error carries `details.recommendedAction` (a machine-stable
token, [../contracts/error-responses.md](../contracts/error-responses.md#recommendedaction-machine-stable-recovery-guidance)).
The agent can branch on that token directly; `recover_from_error` exists for the case where it
wants the full remediation **plan** rather than the single token:

```
recommendedAction          → prompt emits
-------------------------    -----------------------------------------------------------
CREATE_NEW_RUN             → experiments_create (clone) → apply the blocked change → experiments_start → flags_test_eval
END_RUNNING_RUN_FIRST      → runs_end <runningRunId> → retry the original op
START_A_RUN                → experiments_start (or experiments_create then start) → retry
EDIT_DRAFT_THEN_START      → apply a draft change → experiments_start
ADD_VARIANT_TO_ENV         → flags_promote (or variant promotion) → retry the original op
RETRY_AFTER                → wait details.retryAfterMs → retry
REVIEW_APPROVAL_REQUEST    → review details.approvalRequestId with the canonical Review action
REFRESH_AND_REPROPOSE      → read current target state → retry the original mutation with a fresh idempotency key → Review as required
RETRY_REVIEW               → retry the pending request with a new Review idempotency key
READ_PER_ENVIRONMENT       → experiments_list per Environment (App-wide attention rollup over fan-out budget; do not retry)
```

The token is the contract; the prompt is the convenience. An agent that already knows the token
needs no prompt — the recovery is deterministic. This is the fail-loud-then-guide principle: the
error is loud and structured (ADR-0036), and the next step is a stable lookup, never prose parsing.

## Discovery handshake (where this fits in the connect flow)

```
Agent connects to MCP server URL
  → OAuth PRM / auth.md handshake → control-plane token (ADR-0022, see mcp-and-cli-surfaces.md)
  → listResources / listPrompts   → agent learns the glossary, its scopes, and the workflows
  → readResource splitch://quickstart   (optional; the narrative)
  → getPrompt onboard_new_app { orgId, appName }   → a plan
  → executes the plan via derived tools (each Worker-validated)
  → ends on flags_verify / flags_test_eval → green
```

The agent never needs the docs site to onboard: the glossary, the auth model, its own scope, and
the canonical workflows are all in-band MCP capabilities.

## Invariants

1. **Prompts and resources are not tools and never mutate.** State changes only via derived tools.
2. **No second source of truth.** Prompts reference tools by `operationId`; resources transport the
   canonical files (CONTEXT.md, auth.md). No restated schemas, no paraphrased glossary.
3. **Parity-shaped.** Every prompt's step sequence maps 1:1 to the CLI quickstart and the panel
   onboarding sequence (ADR-0023).
4. **Every workflow ends on verify.** Time-to-first-confidence is one round-trip (ADR-0037).
5. **Session-scoped, scope-respecting.** Resources reflect the session's active context and token
   scopes; reading them never widens scope or persists server-side.

## Sources

- [../../adr/0023-remote-mcp-and-cli-as-parity-skins-over-a-shared-typed-client.md](../../adr/0023-remote-mcp-and-cli-as-parity-skins-over-a-shared-typed-client.md) — skins over one client; invariants in the Worker
- [../../adr/0022-agent-and-human-auth-via-auth-md-one-principal-three-doors.md](../../adr/0022-agent-and-human-auth-via-auth-md-one-principal-three-doors.md) — auth doors, auth.md companion
- [../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md](../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md) — tools derived from Zod; one ErrorResponse
- [../../adr/0036-evaluation-is-fail-loud-no-silent-fallback-openfeature-resolution-details.md](../../adr/0036-evaluation-is-fail-loud-no-silent-fallback-openfeature-resolution-details.md) — fail-loud, structured errors
- [../../adr/0037-client-side-configuration-verification-tiered-by-credential.md](../../adr/0037-client-side-configuration-verification-tiered-by-credential.md) — verify ends every workflow
- [mcp-and-cli-surfaces.md](./mcp-and-cli-surfaces.md) — derived tools, context_use, OAuth PRM chain
- [../contracts/mcp-tool-derivation.md](../contracts/mcp-tool-derivation.md) — canonical tool list and naming
- [../contracts/error-responses.md](../contracts/error-responses.md) — recommendedAction recovery tokens
