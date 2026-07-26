# Quickstart: zero to a resolving Flag

The canonical first-run narrative — the same steps for a human at the CLI, an agent over MCP, and a
developer in the control panel (the three are skins over one contract, ADR-0023). The
`onboard_new_app` MCP prompt automates this sequence, and the `splitch://quickstart` MCP resource
serves this file verbatim, so an agent never needs the docs site to onboard (mcp-discovery.md).

> Glossary note: **Flag**, **Variant**, **Run**, **Exposure**, **Targeting Key**, **Environment** all
> mean exactly what [CONTEXT.md](../../CONTEXT.md) says. The `splitch://context` MCP resource is the
> same glossary.

## The shape of it

```
authenticate → pick an Org → create an App (dev+prod Envs auto-provisioned)
            → select the dev Environment → get a Client Key → create a Flag
            → VERIFY (one round-trip) → create an Experiment → Start its Run
            → wire the SDK → first real Exposure
```

Every path ends on a **verify** round-trip, so time-to-first-confidence is a single call on any
credential tier (ADR-0037). A step never ends on "probably fine."

---

## 1. Authenticate

| You are…                      | Door                | How                                                                                 |
| ----------------------------- | ------------------- | ----------------------------------------------------------------------------------- |
| A human at a terminal         | Device flow         | `splitch login` — prints a verification URL, polls until approved                   |
| An agent with an IdP identity | ID-JAG (preferred)  | MCP OAuth PRM handshake on connect; no on-disk credential (mcp-and-cli-surfaces.md) |
| An agent with no identity yet | Anonymous bootstrap | Creates a **provisional Org that auto-deletes in 24h** unless claimed — see below   |

The three doors are detailed in [control-plane/auth-doors.md](control-plane/auth-doors.md); the agent
can read them in-band via `splitch://auth`. After auth, `splitch://capabilities` (or `splitch
context`) shows exactly what your token can do.

> **Anonymous door is a demo.** It is the fastest self-serve start (no human approval needed) but the
> Org carries `demo_expires_at = now + 24h`. To keep your work, claim it (verify an email) before it
> expires. `splitch://active-context` surfaces `demo_expires_at` so an agent can see the deadline and
> prompt the human to claim.

## 2. Pick an Organization

An agent landing cold has no Org ID. Discover the Organizations your token can reach first:

```
splitch orgs list           # CLI
organizations_list          # MCP tool
```

Pick one; its `orgId` feeds the next step.

## 3. Create an App

```
splitch apps create --org <orgId> --name "My App"     # CLI
apps_create { orgId, name }                            # MCP tool
```

This **auto-provisions a `dev` and a `prod` Environment** — you do not create Environments by hand
for the common case (mcp-and-cli-surfaces.md). The response includes the App **and** its two
Environments:

```json
{
  "id": "app_...",
  "organizationId": "org_...",
  "name": "My App",
  "environments": [
    { "id": "env_...", "key": "dev", "name": "Development" },
    { "id": "env_...", "key": "prod", "name": "Production" }
  ]
}
```

## 4. Select the dev Environment (active context)

So you stop retyping `--app` / `--env` on every call:

```
splitch use --app <app|slug> --env dev      # CLI: writes nearest .splitch/config.json
context_use { app, environment: "dev" }     # MCP: carried in the transport session
```

Active context is a pure convenience — it fills in IDs, never widens authorization
(mcp-and-cli-surfaces.md).

## 5. Get the credential your code will hold

Use the **Client Key** for browser/mobile, the **API Key** for a trusted server. The placement rule
and snippets are in [sdk/credentials.md](sdk/credentials.md#which-key-goes-where-first-run-placement).

```
splitch client-key get          # public, safe to ship
api_keys_create                 # secret, surfaced once — store it in a secret manager
```

Your Client Key is **auto-provisioned and open to all origins** so it works immediately (ADR-0034).
Before shipping to production, lock it to your app's origins in one step (control panel or
`PATCH …/client-key`) — the panel flags any open key until you do.

## 6. Create a Flag

```
splitch flags create --key new-checkout --variants on,off       # CLI
flags_create { key: "new-checkout", variants: [...] }           # MCP tool
```

Flag definition is App-level; serving config is per-Environment (ADR-0028). Promote it into your
Environment with `flags promote` / `flags_promote` when you are ready to serve it there.

## 7. VERIFY — the first-confidence step

Confirm the Flag actually resolves for a Targeting Key **without firing an Exposure**:

```
splitch flags verify new-checkout --targeting-key test-user-1     # CLI (data-plane, your SDK credential)
flags_test_eval { flagId, evaluationContext: { targetingKey, idType: "user" } }   # MCP (control-plane, full reason)
```

- `verify` ([sdk/verify-endpoint.md](sdk/verify-endpoint.md)) uses the **same credential your code
  holds** — it answers "is _my_ setup wired?" Under a Client Key the reason is non-revealing; under an
  API Key it names the matched rule (ADR-0037).
- `flags_test_eval` ([sdk/test-evaluation-endpoint.md](sdk/test-evaluation-endpoint.md)) is the
  control-plane, full-reason tier — use it when rule identity matters.

A green verify is your one-call confidence that auth, Environment, credential, and Flag config all
line up. If it fails, the error is structured and names the next step (see Recovery below).

## 8. Roll it out to a percentage (no Experiment required)

A verified Flag is already servable. To put it in front of a slice of real traffic, set the Flag
Configuration's **baseline rollout** — one percentage, no Targeting Rule, no Experiment:

```
splitch flag-config update --rollout 10                        # CLI
flag_config_update { flagId, rollout: { percentage: 10 } }     # MCP tool
```

That is the whole step. The baseline applies to traffic matching no Targeting Rule; if you later add
rules, a matched rule wins and the baseline keeps deciding the rest.

Widening it is safe by construction: **you set a percentage, never a salt.** The server mints the
bucketing salt on the first write and never regenerates it, so 10 → 25 only _adds_ Entities to the
treatment. Nobody already inside the rollout is silently moved out. Clearing the rollout to `null` is
the one visible way to drop the cohort, and re-establishing it starts a fresh one.

In an Environment whose Policy gates `targeting_rollout_value`, this call answers `409
CONFIRMATION_REQUIRED`; repeat it with `confirm: true`. That is the gate working, not an error.

Reach for step 9 when you need to _measure_ the rollout rather than just serve it: Exposures,
allocation, and statistical results all belong to an Experiment Run.

## 9. Start an Experiment Run, wire the SDK, and fire the first real Exposure

An Exposure is a first-touch fact for an Entity in an **Experiment Run**. It carries the Experiment,
Run, Variant, and Targeting Key identity used by analysis. A plain Flag evaluation has no Run to own
that fact, so it returns the Default Variant and records no Exposure.

Create the smallest useful Experiment draft around the Flag, then Start its first Run. Metrics may be
empty for this integration checkpoint; Exposure collection does not require statistical-result work.
The draft must include the Variants, allocation, Targeting Key field and type, and any Targeting Rules
that define the eligible cohort.

```
splitch experiments create --body-json '<CreateExperimentRequest JSON>'
splitch experiments start --confirm <experiment_id>

experiments_create { ...typed Experiment draft... }
experiments_start { experimentId, confirm: true }
```

Use `flags verify` / `flags_test_eval` again after Start to confirm the live Run resolves the expected
Variant without recording an Exposure. Then make the first Exposure-bearing call from the external
product:

```ts
import { createSplitchClient } from "@splitch/sdk";

const splitch = createSplitchClient({ clientKey: "ck_live_..." }); // defaults: edge endpoint, 1s timeout

const evaluationId = crypto.randomUUID(); // retain for retries of this logical Evaluation
const variant = await splitch.evaluate("new-checkout", {
  targetingKey: userId,
  idempotencyKey: evaluationId,
});
// or branch on details — fail-loud is one check:
const d = await splitch.evaluateDetails("new-checkout", {
  targetingKey: userId,
  idempotencyKey: evaluationId,
});
if (d.reason === "ERROR") renderFallback(d.errorCode);
else render(d.value);
```

For a successful fresh assignment under a live Experiment Run, `evaluate` fires an Exposure (ADR-0004);
`peekVariant`/`verify` do not. Disabled Flags, Flags without a controlling Experiment, and Experiments
without a live Run return the Default Variant and record no Exposure. Holdovers replay their prior
Variant without recording a new Exposure. Defaults and the full status→result mapping are in
[sdk/public-evaluate-endpoint.md](sdk/public-evaluate-endpoint.md#sdk-initialization-defaults).

**The loop closes here.** Deploy, call `evaluate()` with a real user, and the dashboard's empty
Exposures state flips to "first Exposure received." Verify proves wiring; the first real `evaluate`
proves the integration. They are different milestones — onboarding is done at the first real Exposure.

---

## Recovery: when a step fails

splitch is fail-loud then guide (ADR-0036). Every operational `409` carries a machine-stable
`details.recommendedAction` token — branch on the token, not on prose
([contracts/error-responses.md](contracts/error-responses.md#recommendedaction-machine-stable-recovery-guidance)).
The `recover_from_error` MCP prompt turns a token into a full remediation plan.

| You hit…                  | It means…                                           | Do…                                              |
| ------------------------- | --------------------------------------------------- | ------------------------------------------------ |
| `CONFIRMATION_REQUIRED`   | the Environment Policy gates this change (ADR-0029) | resend the same call with `confirm: true`        |
| `VARIANT_NOT_AVAILABLE`   | the Variant is not promoted to this Environment     | `flags_promote`, then retry                      |
| `RUN_FROZEN`              | the edit touches a running Run                      | clone into a new draft Run and apply it there    |
| `APP_MISMATCH` on verify  | wrong key for this App / Environment                | fetch the credential for _this_ Env (step 5)     |
| `401` / `403` on evaluate | bad or revoked Client Key, or origin not allowed    | check the key and its origin allow-list (step 5) |

## Sources

- [ADR-0023](../adr/0023-remote-mcp-and-cli-as-parity-skins-over-a-shared-typed-client.md) — one contract, three skins
- [ADR-0027](../adr/0027-environment-is-a-first-class-axis-under-app.md) — Environment is first-class
- [ADR-0036](../adr/0036-evaluation-is-fail-loud-no-silent-fallback-openfeature-resolution-details.md) — fail-loud
- [ADR-0037](../adr/0037-client-side-configuration-verification-tiered-by-credential.md) — verify ends every workflow
- [control-plane/endpoints-experiment-run.md](control-plane/endpoints-experiment-run.md) — create and Start the Experiment Run that owns Exposures
- [control-plane/mcp-discovery.md](control-plane/mcp-discovery.md) — the prompts/resources that automate this
- [CONTEXT.md](../../CONTEXT.md) — the glossary
