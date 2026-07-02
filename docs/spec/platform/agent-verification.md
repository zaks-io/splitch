# Agent verification: local, remote Cursor, and slice Done contracts

Status: scaffold baseline wired; route-level smokes expand slice by slice.
Vocabulary follows [CONTEXT.md](../../../CONTEXT.md).

## Decision

Every implementation slice that changes executable behavior must include agent-verifiable outcomes.
An agent must be able to run the stated command, observe the stated result, and know what the command
does not prove.

A slice is not Done when code compiles. It is Done when the relevant local proof passes and the issue
or PR records the command evidence.

## Done section shape

Each `kind-slice` body should end with a `Done` section containing:

1. **Proof commands** — exact commands from this repo, usually root scripts.
2. **Local service target** — Worker name, URL, route, and fixture data if an HTTP path changed.
3. **Expected result** — status code, response shape, database row, Tinybird output, or CLI/MCP JSON.
4. **Negative proof** — at least one failure case for auth, validation, idempotency, no-write, or
   isolation when the slice touches those contracts.
5. **Not proven** — any hosted, production, scale, or provider behavior the local proof cannot cover.

If a slice cannot meet this shape, it is not ready for agent implementation.

## Verification ladder

| Level                | Required when                                 | Command contract                                                                |
| -------------------- | --------------------------------------------- | ------------------------------------------------------------------------------- |
| Static gate          | Any code/config/docs change                   | `pnpm verify:commit`                                                            |
| Full local gate      | Before push or PR handoff                     | `pnpm verify:push`                                                              |
| API Worker smoke     | Any API Worker, SDK, runtime, or contract hit | `pnpm smoke:local:api` or `pnpm smoke:local -- <worker>`                        |
| Local D1 migration   | Any D1 schema/data-access slice               | `pnpm d1:migrate:local` must fail on bad migrations once migrations exist       |
| Tinybird Local       | Any pipeline/stats/analytics slice            | `pnpm tinybird:local` must fail on bad project files under `infra/tinybird`     |
| Route contract smoke | Any new HTTP route                            | Slice adds fixture plus a local Worker smoke or integration test for that route |
| CLI/MCP parity       | Any control-plane operation                   | Same operation proven through SDK contract plus CLI/MCP schema derivation test  |
| Shared-preview smoke | Hosted integration, real bindings, URLs       | Maintainer-triggered `shared-preview` deploy and smoke, never default PR CI     |
| Production smoke     | Production release                            | GitHub `production` environment approval plus deployment summary evidence       |

`smoke:local:api` is a **separate explicit step**, not part of `verify:push` (which mirrors
`verify:commit`: format, lint, typecheck, Knip, secrets — no Worker boot). Run `pnpm smoke:local:api`
before a PR handoff whenever a slice touches an API Worker, SDK, runtime, or contract; the smoke is
not wired into the push hook today to keep pre-push fast. (Folding it into push — or into CI once a
hosted baseline exists — is a deliberate later call, not an oversight.)

## Local API smoke

`pnpm smoke:local:api` builds the selected workspace graph, starts each API/MCP Worker with
Wrangler local mode on a stable port, verifies the health response, and stops the Worker.

| Worker                   | Workspace                    | Port | Baseline proof                         |
| ------------------------ | ---------------------------- | ---- | -------------------------------------- |
| Control Plane API Worker | `@splitch/control-plane-api` | 8787 | JSON `{ ok, service, platformTarget }` |
| Evaluation Worker        | `@splitch/evaluation-api`    | 8788 | JSON `{ ok, service, platformTarget }` |
| Event Ingest Worker      | `@splitch/event-ingest-api`  | 8789 | JSON `{ ok, service, platformTarget }` |
| Analysis Worker          | `@splitch/analysis-api`      | 8790 | JSON `{ ok, service, platformTarget }` |
| Auth API Worker          | `@splitch/auth-api`          | 8791 | JSON `{ ok, service, platformTarget }` |
| MCP Worker               | `@splitch/mcp-server`        | 8792 | JSON `{ ok, service, platformTarget }` |

Selectors:

- `pnpm smoke:local -- api` smokes the API/MCP set.
- `pnpm smoke:local -- all` also smokes Control Panel and Marketing.
- `pnpm smoke:local -- @splitch/control-plane-api` smokes one Worker.

The smoke requires `platformTarget = "local"`. A shared-preview or production smoke must assert the
target it actually deployed.

## Remote Cursor requirements

The same local commands must work in the remote Cursor environment after `pnpm install`. They must not
require a browser login, keychain access, production credentials, or Cloudflare/Tinybird remote writes.

Remote Cursor uses the same repo scripts:

```
pnpm smoke:local:api
pnpm verify:push
```

The smoke binds to `127.0.0.1` by default because the agent only needs to call it from the same
container. Use `SPLITCH_SMOKE_IP=0.0.0.0` only when a human needs a forwarded preview port; the fetch
host remains local unless `SPLITCH_SMOKE_HOST` is set.

The `remote-cursor` tracker label means the work is allowed to run in that environment. It is not proof
that hosted issue-assigned delegation is available. Issue-assigned delegation still needs the code host
and the `splitch` repo-route label from [../../agents/workflow/config.md](../../agents/workflow/config.md).

## Slice requirements by area

- **Contracts:** Zod tests for success/failure shapes, route metadata tests, OpenAPI generation smoke,
  and MCP schema derivation for new control-plane routes.
- **Worker runtime:** guard matrix tests in `@splitch/worker-runtime` plus one happy-path mount smoke in
  each participating Worker.
- **Evaluation:** deterministic `assign()` tests, holdover replay tests with fake Assignment Store,
  exposure/no-exposure branch tests, and local Evaluation Worker route smoke.
- **Pipeline:** fixture raw events, dedup query tests, Tinybird Local build/test, and no-write proof for
  peek and test-evaluation paths.
- **Control Plane API:** D1 migration check, repository tests with app-scoped fixtures, auth/scope
  negative tests, and local route smoke through the Worker.
- **SDK/CLI/MCP:** unit tests against fake transport, CLI exit-code tests, MCP schema parity tests, and
  a dry-run test-evaluation smoke when the endpoint exists.
- **Stats:** unit/golden/property tests from [../stats/statistical-rigor-verification.md](../stats/statistical-rigor-verification.md)
  before result endpoints are treated as Done.
- **Frontend:** component tests for stateful flows, route smoke, loader error-state tests, and browser
  verification for any user-facing layout or interaction change.

## Current gaps

- `pnpm d1:migrate:local` and `pnpm tinybird:local` intentionally skip until migrations and Tinybird
  files exist. The slice that adds those files must convert the skip to a failing validator.
- Hosted smoke, shared-preview deploy/reset, production deploy, and rollback scripts are still not
  wired. They cannot be used as Done proof yet.
- Real provider credentials, real Cloudflare bindings, Tinybird Cloud, code host remote, and repo-route
  tracker wiring are not provisioned.

## Sources

- [local-quality-gates.md](./local-quality-gates.md)
- [deployment-pipeline.md](./deployment-pipeline.md)
- [worker-runtime.md](./worker-runtime.md)
- [../../agents/workflow/config.md](../../agents/workflow/config.md)
