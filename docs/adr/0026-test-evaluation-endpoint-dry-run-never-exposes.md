# Test-evaluation (dry-run) endpoint on the control plane: resolves and explains, never exposes

**Status:** accepted

The agent-first lifecycle (configure an App → wire up an SDK → **verify it's working**) needs a way to confirm
a Flag resolves correctly end-to-end **without deploying the customer's service**. splitch ships a
**test-evaluation endpoint** on the control plane: given a Flag, a Targeting Key, and an Evaluation Context, it
returns the **resolved Variant and the reason** (which Targeting Rule matched, or default-because-disabled /
no-match). This is the conventional flag-platform **debugger / evaluation-reasons** capability (LaunchDarkly's
evaluation reasons, Statsig/Optimizely's debugger) — followed, not invented. The CLI / MCP / agent calls it as
the "verify" step; it is also the human's debugging tool.

**A dry-run NEVER fires an Exposure — by construction.** A test evaluation is not a real Entity encountering its
Variant; counting it would inject phantom Exposures into a Run and poison analysis (the glossary's Exposure
definition; ADR-0005 dedup). ADR-0004 makes _the SDK accessor_ the exposure-firing path; the test-evaluation
endpoint is categorically the **non-exposing** path — the same role as the "peek without exposing" accessor,
exposed as a control-plane operation. It computes Assignment (a pure function, ADR-0001) and the resolution
reason, and **writes nothing**: no Exposure log row, no Assignment Store write (ADR-0007/0008). Exposure-free is
a structural property of the endpoint, not a flag a caller can forget to set.

**It runs against live edge config for a named Environment**, so "verify it's working" verifies the
_deployed_ truth — the same config the data-plane evaluate endpoint would resolve against — not a staged
copy that could disagree. Flag Configuration is per-Environment (ADR-0027), so the dry-run is an
Environment-scoped control-plane operation: the endpoint is routed under `/{app}/{env}/…` and resolves
against that Environment's KV config, and the same `(orgSlug, appSlug, env)` the caller would verify in
prod versus dev selects which deployed truth is checked.

**Reached with the control-plane token (ADR-0022), not a Client/API Key (ADR-0018).** It is a management/debug
operation that returns the resolution _reason_ (which rule matched), which the public Client Key is forbidden to
reveal (ADR-0018: the evaluate endpoint returns only the resolved Variant, never the rule set). So the
test-evaluation endpoint lives behind the control-plane authz surface, authorized like every other config
operation, and is a thin 1:1 control-plane endpoint surfaced as one MCP tool and one CLI command (ADR-0023).

## Considered options

- **Reuse the data-plane evaluate endpoint for verification** — rejected: that path fires Exposures by design
  (ADR-0004) and deliberately withholds the resolution reason (ADR-0018). A verify step that pollutes analysis
  and can't explain _why_ a Variant was chosen is the wrong tool. The dry-run is a distinct, exposure-free,
  reason-returning surface.
- **A "test mode" boolean on the real evaluate call that suppresses the Exposure** — rejected: a suppressible
  side effect is exactly the forget-to-set footgun ADR-0004 designed out. Exposure-free must be structural (a
  separate endpoint), not a parameter.
- **Make verification the customer's job (deploy the SDK, watch real traffic)** — rejected: it defeats the
  agent-first goal (confirm config before any deploy) and every reference platform ships a debugger for this.

## Consequences

- **One more thin control-plane endpoint** → one MCP tool + one CLI command (ADR-0023), authorized by the
  control-plane token (ADR-0022). No new auth surface.
- **The resolution-reason shape is a contract type** (ADR-0025, Zod-first): `{ variant, reason }` where reason
  distinguishes rule-match / default-disabled / no-match-default. Both skins render it from the same contract.
- **Exposure-free is enforced at the endpoint, in the Worker** (ADR-0023's invariant-in-the-Worker rule) — the
  dry-run computes Assignment + reason and is wired to no write path; there is no code path from it to the
  Exposure log or Assignment Store.
- **No new glossary term.** "test evaluation" / "dry-run" / "debugger" is interface vocabulary; the domain
  concepts it touches (Assignment, Exposure, Targeting Rule, Variant) already exist. A CONTEXT.md note may
  record that the dry-run is the non-exposing evaluation path, paired with ADR-0004.
