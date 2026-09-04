<div align="center">

# splitch

**Unified feature flags and A/B experimentation on Cloudflare's edge — agent-first,
built to scale to millions of events.**

[splitch.dev](https://splitch.dev) · [Quickstart](https://splitch.dev/quickstart) · [Docs](https://splitch.dev/docs) · [Control panel](https://app.splitch.dev) · [llms.txt](https://splitch.dev/llms.txt)

[![CI](https://github.com/zaks-io/splitch/actions/workflows/ci.yml/badge.svg)](https://github.com/zaks-io/splitch/actions/workflows/ci.yml)
[![npm @splitch/sdk](https://img.shields.io/npm/v/@splitch/sdk.svg?label=%40splitch%2Fsdk)](https://www.npmjs.com/package/@splitch/sdk)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE.md)

</div>

> **Alpha.** The hosted platform, CLI, and SDK are live and published to npm. APIs may
> still change before 1.0.

## What it is

splitch is a feature-flag and experimentation platform where an AI agent has the same
capability a person does. Every operation in the control panel is also a typed MCP tool
and a CLI command, because all three are thin skins over one Zod-first contract.

- **One evaluation call.** `evaluate()` resolves a Variant at the edge and fires the
  Exposure that experiment analysis counts. No local config file to sync.
- **Fail-loud, always.** A failure is never disguised as a plausible default. Every error
  carries a stable code with a page at `https://splitch.dev/docs/error/{code}`.
- **Flags and experiments in one model.** A Flag resolves through Targeting Rules, then a
  baseline rollout, then its Default Variant. Attach an Experiment Run when you want to
  _measure_ the rollout rather than just serve it.
- **Built for scale.** KV serves reads, per-key Durable Objects serialize first-touch
  writes, and events append to Tinybird for analysis.

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
Environments plus a Client Key for each.

```bash
splitch orgs create --name "My Org" --json
splitch apps create --org <orgId> --name "My App" --json
splitch use --app my-app --env dev

splitch flags create --key new-checkout --variants on,off --json
splitch flag-config update new-checkout --enabled true --rollout 100 --json
```

**3. Verify before you write any code.** This is a real data-plane round trip on the same
credential your app will hold, and it fires no Exposure:

```bash
splitch flags verify new-checkout --targeting-key test-user-1 --json
# { "value": true, "variantName": "on", "reason": "SPLIT" }
```

A `reason` of `DISABLED` means the Flag Configuration is still off; `DEFAULT` means it is
enabled with no rollout. Neither is a wiring problem.

**4. Wire the SDK.** Grab the public Client Key with `splitch client-key get` and paste its
`keyMaterial` (`pk_…`) value:

```ts
import { createSplitchClient } from "@splitch/sdk";

const splitch = createSplitchClient({ clientKey: "pk_..." });

const enabled = await splitch.evaluate("new-checkout", {
  targetingKey: user.id,
  idempotencyKey: crypto.randomUUID(),
  defaultValue: false,
});
```

Verify proves the wiring. The first real `evaluate()` from your deployed product proves the
integration: that is when the dashboard flips to "first Exposure received."

## Packages

| Package                                      | npm                                                                                                               | What it's for                                                                                            |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| [`@splitch/sdk`](packages/sdk)               | [![npm](https://img.shields.io/npm/v/@splitch/sdk.svg)](https://www.npmjs.com/package/@splitch/sdk)               | Evaluate Flags from servers, browsers, and edge runtimes. Includes `/browser` and `/react` entry points. |
| [`@splitch/cli`](apps/cli)                   | [![npm](https://img.shields.io/npm/v/@splitch/cli.svg)](https://www.npmjs.com/package/@splitch/cli)               | The `splitch` command: manage Orgs, Apps, Environments, Flags, and Experiments with stable JSON output.  |
| [`@splitch/convex`](packages/convex)         | [![npm](https://img.shields.io/npm/v/@splitch/convex.svg)](https://www.npmjs.com/package/@splitch/convex)         | Pre-1.0 Convex Component for synced local evaluation inside queries and mutations.                       |
| [`@splitch/cloudflare`](packages/cloudflare) | [![npm](https://img.shields.io/npm/v/@splitch/cloudflare.svg)](https://www.npmjs.com/package/@splitch/cloudflare) | Customer-owned Worker for durable local evaluation through a Cloudflare service binding.                 |

Other packages and apps in the workspace are internal to the platform and not published.

### Using the SDK

```ts
// Server: one call per evaluation, fires an Exposure.
const enabled = await splitch.evaluate("new-checkout", {
  targetingKey: user.id,
  idempotencyKey: crypto.randomUUID(),
  defaultValue: false,
});

// Whole page in one round trip: no Exposure, safe to serialize into SSR HTML.
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
right up front: see [the six methods](https://splitch.dev/docs/sdk/methods) and
[credentials](https://splitch.dev/docs/sdk/credentials). The short rule: the public Client
Key (`pk_…`) evaluates and may ship to clients; the secret API Key (`sk_…`) peeks and stays
on a server.

### Using it from an agent

Agents install nothing. Point an MCP client at **`https://mcp.splitch.dev`** and
authenticate in-band over the OAuth handshake. The server exposes one typed tool per
control-plane endpoint, plus guided prompts (`onboard_new_app`, `ship_a_flag`,
`run_an_experiment`, `recover_from_error`) and read-only resources (`splitch://context` for
the glossary, `splitch://capabilities` for what the current token can do).

### Examples

- [`examples/convex`](examples/convex) — a Convex app mounting `@splitch/convex` end to end:
  install, config sync, query peeks, transactional mutation Exposures, uninstall.
- [`fixtures/ssr-sdk-consumer`](fixtures/ssr-sdk-consumer) — framework-neutral Node SSR plus
  browser hydration from an `evaluateAll` bootstrap.
- [`fixtures/convex-sdk-consumer`](fixtures/convex-sdk-consumer) — calling `@splitch/sdk`
  from Convex actions and HTTP actions.

## Documentation

**Public docs** (for people using the hosted platform):

- [Quickstart](https://splitch.dev/quickstart) — zero to a resolving Flag
- [Flags](https://splitch.dev/docs/flags) — Configuration, rollouts, Targeting Rules
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
  auth-api/            OAuth device flow, ID-JAG, anonymous bootstrap
  control-plane-api/   Authenticated management API (the one typed contract)
  evaluation-api/      Data-plane Worker: the hot evaluate path
  event-ingest-api/    Append-only Exposure / Metric / Web Event intake
  analysis-api/        Statistical result read model over Tinybird
  mcp-server/          Remote MCP transport (mcp.splitch.dev)
  control-panel/       The web app (app.splitch.dev)
  marketing/           Marketing site and public docs (splitch.dev)
  cli/                 @splitch/cli
packages/
  sdk/                 @splitch/sdk
  convex/              @splitch/convex
  cloudflare/          @splitch/cloudflare
  contracts/           Zod schemas: the single source of truth for every surface
  evaluation-core/     Pure assignment and resolution logic
  stats/               The statistics engine
  db/, ui/, ...        Shared internals
docs/, infra/, e2e/, fixtures/, examples/
```

## Local development

Requires **Node.js 24+** and **pnpm 11.8** (`corepack enable` picks up the pinned version
from `package.json`).

```bash
pnpm install
pnpm dev            # every Worker (wrangler) and frontend (vite), in parallel
pnpm dev:api        # just the API Workers
pnpm test           # the full test suite
pnpm verify:push    # the full local gate (lint, typecheck, knip, format, secrets, migrations)
```

Lefthook runs `verify:commit` on commit and `verify:push` on push; see
[`docs/spec/platform/local-quality-gates.md`](docs/spec/platform/local-quality-gates.md).

To point the CLI at a local stack instead of hosted splitch:

```bash
export SPLITCH_PLATFORM_TARGET=local
```

## Security

Security is an enforced product contract, not an afterthought. See
[`docs/spec/platform/security-model.md`](docs/spec/platform/security-model.md) for the trust
boundaries and threat model, and [`SECURITY.md`](SECURITY.md) to report a vulnerability.
Please do not open a public issue for a security report.

Enforced on every pull request and push to `main`: gitleaks secret scanning, the full
contract and correctness gate, Harden-Runner egress auditing, and every GitHub Action
pinned to a commit SHA. Semgrep, OSV-Scanner, Trivy, and Scorecard run daily and report
into the Security tab. Scheduled operational scanner failures fail their jobs and open a tracking
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
