<div align="center">

# splitch

**Control what ships. Learn what works.**

Turn features on or off without redeploying your app. Run A/B experiments to measure how
changes affect your users, like comparing feedback on a cheaper model against the one you
use today. Built for agents: once authenticated and set up, your coding agent can manage
Flags and Experiments through the CLI.

[splitch.dev](https://splitch.dev) · [Quickstart](https://splitch.dev/quickstart) · [Docs](https://splitch.dev/docs) · [Control panel](https://app.splitch.dev) · [llms.txt](https://splitch.dev/llms.txt)

[![CI](https://github.com/zaks-io/splitch/actions/workflows/ci.yml/badge.svg)](https://github.com/zaks-io/splitch/actions/workflows/ci.yml)
[![npm @splitch/sdk](https://img.shields.io/npm/v/@splitch/sdk.svg?label=%40splitch%2Fsdk)](https://www.npmjs.com/package/@splitch/sdk)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE.md)

</div>

> **Alpha.** The hosted platform, CLI, and SDK are live and published to npm. APIs may
> still change before 1.0.

## What it is

splitch is a feature-flag and experimentation platform where an AI agent has the same
capability a person does. The control panel, the CLI, and the MCP server are thin skins
over one Zod-first route contract. A CI parity check fails the build if a control-plane
operation exists as a CLI command but not as an MCP tool, or the other way round, unless the
gap is recorded as a reviewed exception.

- **One evaluation call.** `evaluate()` resolves a Variant at the edge and fires the
  Exposure that experiment analysis counts. No local config file to sync.
- **Fail-loud, always.** A failure is never disguised as a plausible default. Every error
  carries a stable code with a page at `https://splitch.dev/docs/error/{code}`.
- **Flags and experiments in one model.** A Flag resolves through its Targeting Rules, then
  a baseline rollout, then its Default Variant. Attach an Experiment when you want to
  _measure_ the change rather than just serve it: while a Run is live, it assigns users
  randomly and sticks each one to their Variant.
- **Statistics you can act on.** Runs default to always-valid sequential intervals, so
  checking results early does not inflate false positives; a fixed horizon is opt-in. CUPED
  variance reduction, SRM checks, Benjamini-Hochberg correction across a Run's decision
  Metrics, and Guardrail checks are built in.
- **Built for scale.** KV serves reads, per-key Durable Objects serialize first-touch
  writes, and events reach Tinybird through queue-backed microbatches.

### Why "splitch"

**Split** testing and a feature **switch**, fused into one word, because they are one
product here. A Flag decides what a user sees; a Run measures whether it mattered. The logo
mark cuts the name at the pipe, `split|ch`, into the two arm colors: cobalt for Control,
chartreuse for Treatment. That same divided track is the allocation slider in the panel and
the series colors on the results plot. The mark is the product, not decoration.

## Quickstart

The full path from zero to a resolving Flag lives at
**[splitch.dev/quickstart](https://splitch.dev/quickstart)**. The short version:

**1. Install the CLI** (Node.js 24+):

```bash
npm install --global @splitch/cli
splitch login
```

**2. Create an App and a Flag.** Creating an App auto-provisions `dev` and `prod`
Environments plus a Client Key for each. `dev` allows every change; `prod` has a Policy that
makes gated writes such as `flag-config update` require `--confirm`.

```bash
splitch orgs create --name "My Org" --json
splitch apps create --org <orgId> --name "My App" --json
splitch use --app my-app --env dev

splitch flags create --key new-checkout --variants on,off \
  --lifecycle-class release --owner checkout-team --expires-at 2027-01-01T00:00:00Z --json
splitch flag-config update new-checkout --enabled true --rollout 100 --json
```

**3. Verify before you write any code.** This is a real data-plane round trip on the same
credential your app will hold, and it fires no Exposure:

```bash
splitch flags verify new-checkout --targeting-key test-user-1 --json
# { "value": true, "variantName": "on", "reason": "SPLIT" }
```

A `reason` of `DISABLED` means the Flag Configuration is still off; `DEFAULT` means it is
enabled with no rollout and no live Run. Neither is a wiring problem.

**4. Wire the SDK.** Grab the public Client Key with `splitch client-key get` and paste its
`keyMaterial` (`pk_…`) value:

```ts
import { createSplitchClient } from "@splitch/sdk";

const splitch = createSplitchClient({ clientKey: "pk_..." });

const enabled = await splitch.evaluate("new-checkout", {
  targetingKey: user.id,
  defaultValue: false,
});
```

Verify proves the wiring. The first real `evaluate()` from your deployed product proves the
integration: that is when the dashboard flips to "first Exposure received."

## Packages

| Package                                      | npm                                                                                                               | What it's for                                                                                    |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| [`@splitch/sdk`](packages/sdk)               | [![npm](https://img.shields.io/npm/v/@splitch/sdk.svg)](https://www.npmjs.com/package/@splitch/sdk)               | Evaluate Flags and send Metric Events from servers, browsers, and edge runtimes.                 |
| [`@splitch/cli`](apps/cli)                   | [![npm](https://img.shields.io/npm/v/@splitch/cli.svg)](https://www.npmjs.com/package/@splitch/cli)               | The `splitch` command: manage the whole control plane with stable JSON output.                   |
| [`@splitch/convex`](packages/convex)         | [![npm](https://img.shields.io/npm/v/@splitch/convex.svg)](https://www.npmjs.com/package/@splitch/convex)         | Pre-1.0 Convex Component for synced local evaluation inside queries and mutations.               |
| [`@splitch/cloudflare`](packages/cloudflare) | [![npm](https://img.shields.io/npm/v/@splitch/cloudflare.svg)](https://www.npmjs.com/package/@splitch/cloudflare) | Pre-1.0 customer-owned Worker for durable local evaluation through a Cloudflare service binding. |

Other packages and apps in the workspace are internal to the platform and not published on
their own. The typed control-plane client ships inside `@splitch/sdk/control-plane`.

`@splitch/sdk` entry points:

| Import                          | What it's for                                                                      |
| ------------------------------- | ---------------------------------------------------------------------------------- |
| `@splitch/sdk`                  | Server client: evaluate, peek, verify, precompute, and send Metric Events          |
| `@splitch/sdk/browser`          | Browser client hydrated once, then synchronous reads with a batched Exposure queue |
| `@splitch/sdk/react`            | `SplitchProvider`, `useFlag`, `useFlagDetails`, `useSplitchClient`                 |
| `@splitch/sdk/sentry`           | Resolution reporter that feeds Flag values into Sentry's feature-flag context      |
| `@splitch/sdk/control-plane`    | Typed control-plane client and Zod contracts, the same ones the CLI and MCP use    |
| `@splitch/sdk/local-evaluation` | Snapshot schemas and the pure evaluator behind `@splitch/convex`                   |

### Using the SDK

```ts
// Server: one call per evaluation, fires an Exposure.
const enabled = await splitch.evaluate("new-checkout", {
  targetingKey: user.id,
  defaultValue: false,
});

// Whole page in one round trip: no Exposure, safe to serialize into SSR HTML. It echoes
// the Evaluation Context, so pass only attributes you are willing to publish.
const precomputed = await splitch.evaluateAll({ targetingKey: user.id });
```

```ts
// Browser: fetch once, then read Flags synchronously with zero per-read network.
import { createSplitchBrowserClient } from "@splitch/sdk/browser";

const splitch = createSplitchBrowserClient({
  clientKey: "pk_...",
  context: { targetingKey: user.id },
  bootstrap: precomputed, // optional server evaluateAll result
});
await splitch.init();
const on = splitch.evaluate("new-checkout", false);
```

```tsx
// React: one Flag per hook, so a change re-renders only its own subscribers.
import { SplitchProvider, useFlag } from "@splitch/sdk/react";

<SplitchProvider client={splitch}>
  <Checkout />
</SplitchProvider>;

function Checkout() {
  const enabled = useFlag("new-checkout", false);
  return enabled ? <NewCheckout /> : <CurrentCheckout />;
}
```

Which methods fire an Exposure and which credential each one needs is the thing to get
right up front:

| Server method     | Fires an Exposure | Credential                                           |
| ----------------- | ----------------- | ---------------------------------------------------- |
| `evaluate`        | yes               | Client Key                                           |
| `evaluateDetails` | yes               | Client Key                                           |
| `peekVariant`     | no                | API Key with `data-plane:evaluate`                   |
| `verify`          | no                | Client Key, or an API Key with `data-plane:evaluate` |
| `evaluateAll`     | no                | Client Key, or an API Key with `data-plane:evaluate` |
| `track`           | no                | Client Key, or an API Key with `data-plane:write`    |

`activate` records a Metric Event like `track` and also creates an Activation for every
matching live Run. See [methods](https://splitch.dev/docs/sdk/methods) and
[credentials](https://splitch.dev/docs/sdk/credentials). The short rule: the public Client
Key (`pk_…`) evaluates and may ship to clients; the secret API Key (`sk_…`) peeks and stays
on a server.

### Using it from an agent

**MCP.** Point an MCP client at **`https://mcp.splitch.dev`** and authenticate in-band over
the OAuth handshake. Nothing to install. The server exposes one typed tool per control-plane
route, plus `context_use` to select an App and Environment. The exceptions are
`flags verify` and the `cloudflare setup`, `status`, and `remove` commands, which exist only
in the CLI. It also ships:

- Guided prompts: `onboard_new_app`, `ship_a_flag`, `run_an_experiment`, `end_a_run`,
  `recover_from_error`, `diagnose_setup`.
- Read-only resources: `splitch://context` (the glossary), `splitch://quickstart`,
  `splitch://auth` (sign-in paths and scope widening), `splitch://active-context` (the
  session's selected App and Environment), `splitch://capabilities` (the tools the current
  token can call).

**CLI plus skill.** Coding agents with a shell can drive the `splitch` CLI instead. Install
the [splitch skill](skills/splitch/SKILL.md) so the agent knows the workflow:

```bash
npx skills add https://github.com/zaks-io/splitch/tree/main/skills/splitch
```

### The CLI

Every command takes `--json` for a single machine-readable document, and `--help` lists the
exact flags it accepts. Unknown flags are rejected. The command groups:

| Area                     | Commands                                                                                                                                                                 |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Session                  | `login`, `logout`, `use`, `context`, `health`                                                                                                                            |
| Organizations and access | `orgs`, `organization-members`, `organization-usage`, `app-members`                                                                                                      |
| Apps and Environments    | `apps`, `envs`, `env-policy`, `client-key`, `api-keys`, `app-attention-rollup`                                                                                           |
| Flags                    | `flags` (including `promote`, `test-eval`, `verify`), `flag-variants`, `flag-config`, `flag-targeting-rules`, `segments`                                                 |
| Experiments              | `experiments`, `runs`, `experiment-results`, `metrics`, `event-definitions`, `event-definition-versions`, `conclusion-promotion-requests`, `environment-exposure-status` |
| Approvals                | `approval-requests`, `approval-request-reviews`                                                                                                                          |
| Integrations             | `cloudflare` (`setup`, `status`, `remove`), `cloudflare-installations`, `convex-installations`, `sentry-installations`, `sentry-secret-rotations`                        |

Full reference: [splitch.dev/docs/cli](https://splitch.dev/docs/cli).

### Examples

- [`examples/convex`](examples/convex) — a Convex app mounting `@splitch/convex` end to end:
  install, config sync, query peeks, transactional mutation Exposures, uninstall.
- [`examples/sentry`](examples/sentry) — both halves of the Sentry integration: Flag change
  tracking webhooks and the `@splitch/sdk/sentry` resolution reporter.
- [`fixtures/ssr-sdk-consumer`](fixtures/ssr-sdk-consumer) — framework-neutral Node SSR plus
  browser hydration from an `evaluateAll` bootstrap.
- [`fixtures/convex-sdk-consumer`](fixtures/convex-sdk-consumer) — calling `@splitch/sdk`
  from Convex actions and HTTP actions.

## Documentation

**Public docs** (for people using the hosted platform):

- [Quickstart](https://splitch.dev/quickstart) — zero to a resolving Flag
- [Flags](https://splitch.dev/docs/flags) — Configuration, rollouts, Targeting Rules
- [CLI](https://splitch.dev/docs/cli) — every command and its flags
- [Code agents](https://splitch.dev/docs/code-agents) — implement panel changes in a consumer repo
- [SDK guide](https://splitch.dev/docs/sdk/install) — install, credentials, methods, browser, React, Convex
- [Error catalog](https://splitch.dev/docs/errors) — every code, its cause, and its fix. Append `.md` to any page for plain markdown.

**Repo docs** (for people working on splitch):

- [`docs/vision.md`](docs/vision.md) — the north star: who it's for and what "good" means
- [`CONTEXT.md`](CONTEXT.md) — the glossary and ubiquitous language. Start here.
- [`docs/spec/`](docs/spec/) — the implementation source of truth
- [`docs/adr/`](docs/adr/) — why each decision was made
- [`AGENTS.md`](AGENTS.md) — how coding agents work in this repo

## Repository layout

```
apps/
  auth-api/            OAuth device flow, ID-JAG, anonymous bootstrap and claim, JWKS
  control-plane-api/   Authenticated management API: Flags, Experiments, approvals,
                       Promotion, integrations, privacy jobs
  evaluation-api/      Data-plane Worker: evaluate, evaluateAll, peek, verify
  event-ingest-api/    Append-only Exposure / Metric / Web Event intake into Tinybird
  analysis-api/        Statistical results over Tinybird; reachable only by service binding
  mcp-server/          Remote MCP server (mcp.splitch.dev)
  control-panel/       The web app (app.splitch.dev), TanStack Start on Workers
  marketing/           Marketing site, public docs, llms.txt, agent skill (splitch.dev)
  cli/                 @splitch/cli
packages/
  sdk/                 @splitch/sdk
  convex/              @splitch/convex
  cloudflare/          @splitch/cloudflare
  contracts/           Zod schemas and the route registry: the source of truth for every surface
  control-plane-sdk/   Typed control-plane client shared by the panel, CLI, and MCP server
  evaluation-core/     Pure assignment and resolution logic
  stats/               The statistics engine
  db/                  Drizzle schema, repositories, and D1 migrations
  privacy/             Salts, pseudonymous identity keys, scrubbing
  worker-runtime/      Shared Worker routing, auth, idempotency, rate limits
  observability/       Sentry wiring and scrubbed logging
  bounded-body/        Size-capped request body reader
  ui/                  Shared React components and theme
  repo-lint/           Publishing and release policy checks
infra/tinybird/        Tinybird datasources, pipes, and tests
skills/splitch/        The public agent skill
e2e/, tests/           Playwright suites for the panel, local fleet, and shared preview
docs/, scripts/, fixtures/, examples/, assets/
```

## Local development

Requires **Node.js 24+** and **pnpm 11.8** (`corepack enable` picks up the pinned version
from `package.json`).

```bash
pnpm install
pnpm dev            # every Worker (wrangler) and frontend (vite), in parallel
pnpm dev:api        # just the API Workers and the MCP server
pnpm test           # the full test suite
pnpm verify:push    # the push gate (lint, typecheck, knip, format, secrets, D1 migrations, Tinybird)
```

Lefthook runs `verify:commit` on commit and `verify:push` on push; see
[`docs/spec/platform/local-quality-gates.md`](docs/spec/platform/local-quality-gates.md). The
hooks need [`gitleaks`](https://github.com/gitleaks/gitleaks) on your `PATH`, and
`verify:push` also needs the Tinybird CLI (`tb`) with Docker for its Tinybird Local tests.
CI runs the larger `verify:ci` gate.

To point the CLI at a local stack instead of hosted splitch:

```bash
export SPLITCH_PLATFORM_TARGET=local
```

## Security

Security is an enforced product contract, not an afterthought. See
[`docs/spec/platform/security-model.md`](docs/spec/platform/security-model.md) for the trust
boundaries and threat model, and [`SECURITY.md`](SECURITY.md) to report a vulnerability.
Please do not open a public issue for a security report.

Enforced on every pull request and push to `main`: gitleaks secret scanning,
`pnpm audit` at high severity, the full contract and correctness gate, and Harden-Runner
egress auditing on the CI gate. Every GitHub Action is pinned to a commit SHA. Semgrep,
OSV-Scanner, Trivy, and Scorecard run daily and report into the Security tab. CodeQL is
parked and runs only on manual dispatch. Scheduled operational scanner failures fail their jobs and open a tracking
issue. Manually dispatched runs fail their jobs on operational errors but skip alerting and create no
issue. The security workflow has no pull-request or push trigger, so it does not gate merges. Making
it gate pull requests waits on a one-time audit of the final dependency set.
`SECURITY.md` lists exactly what runs and what does not.

## Contributing

Bug reports and feature requests are welcome in
[GitHub Issues](https://github.com/zaks-io/splitch/issues). See
[`CONTRIBUTING.md`](CONTRIBUTING.md) for how to report a good bug, set up the repo, and get
a pull request merged.

## License

[Apache License 2.0](LICENSE.md). See [`NOTICE.md`](NOTICE.md) for attribution. The hosted
splitch service is operated by [Zaks.io, LLC](https://zaks.io/).
