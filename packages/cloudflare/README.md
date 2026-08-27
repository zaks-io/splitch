# @splitch/cloudflare

Splitch Flag and Experiment evaluation inside a Worker you own. `@splitch/cloudflare` is deployed
into your own Cloudflare account, backed by a SQLite Durable Object. splitch pushes configuration to
it; your application Workers evaluate through a service binding, so no evaluation crosses the public
Internet. One deployment is bound to one splitch Environment.

Use it when you already run on Workers and want local latency and durable Assignment state. A Worker
that is happy with a network round-trip should use the ordinary server client
([`@splitch/sdk`](https://www.npmjs.com/package/@splitch/sdk)) instead.

- Full guide: <https://splitch.dev/docs/sdk/cloudflare>
- Every failure code, with its cause and its fix: <https://splitch.dev/docs#errors>

## Install

```bash
npm install @splitch/cloudflare
npm install --global @splitch/cli
```

Node 24 or newer for the CLI that drives setup. The package itself runs in the Workers runtime.

## Setup

Setup is one command. Before running it you need:

| Requirement                                        | Why                                                                          |
| -------------------------------------------------- | ---------------------------------------------------------------------------- |
| `SPLITCH_API_KEY` exported                         | The Environment's API Key. The name is exact; setup reads no other variable. |
| Wrangler 4 in the app                              | Setup shells out to `pnpm exec wrangler`, so pnpm must resolve it.           |
| `wrangler login`                                   | Setup deploys the integration Worker into your account.                      |
| An application `wrangler.jsonc` or `wrangler.json` | Setup adds the `SPLITCH` service binding to it.                              |

```bash
export SPLITCH_API_KEY=sk_...
splitch cloudflare setup --env production
```

The command fails before it mutates anything if the API Key, the application Wrangler config, the
Wrangler session, or the Cloudflare account is unavailable. Once past that gate it:

1. writes `.splitch/cloudflare/production/{wrangler.jsonc,worker.ts,state.json}` and appends
   `.splitch/cloudflare/*/state.json` to your `.gitignore`,
2. deploys the integration Worker as `splitch-config-production`,
3. stores `SPLITCH_API_KEY` and `SPLITCH_PUSH_SECRET` as Wrangler secrets on that Worker,
4. registers the deployment with splitch and waits (up to 60 seconds) until the pushed configuration
   version is applied,
5. adds the `SPLITCH` service binding to your application's Wrangler environment and reruns
   `wrangler types`.

The state file is written mode `0600`. An exact rerun discovers and repairs the existing
installation. Reusing the Environment name with a different API Key, account, endpoint, or secret
fails [`IDEMPOTENCY_KEY_CONFLICT`](https://splitch.dev/docs/error/IDEMPOTENCY_KEY_CONFLICT) rather
than quietly rebinding it.

## Evaluate from your Worker

`wrangler types` makes `env.SPLITCH` a typed service binding. The same call handles ordinary Flags,
Targeting Rules, baseline rollouts, live Experiments, and holdover replay.

```ts
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const enabled = await env.SPLITCH.evaluate("new-checkout", {
      targetingKey: userId,
      idempotencyKey: crypto.randomUUID(),
      defaultValue: false,
    });

    return new Response(enabled ? "new" : "current");
  },
};
```

| Method            | Returns                          | Fires an Exposure |
| ----------------- | -------------------------------- | ----------------- |
| `evaluate`        | the Variant value                | yes               |
| `evaluateDetails` | full `ResolutionDetails`         | yes               |
| `status`          | installation and delivery health | no                |

`targetingKey` and `idempotencyKey` are required; `idType` defaults to `user`, `attributes` to `{}`,
and `defaultValue` to `false`. Both evaluation methods are Exposure-bearing, because an application
RPC is an explicit encounter. There is no `remote`, `experiment`, `sendExposure`, or fallback option.
Use `status()` for health checks, never an evaluation accessor.

Retrying with the same `idempotencyKey` and identical input returns the stored result and creates no
second Exposure. Reusing that key with different input fails loud rather than serving the stale
answer.

## Before the first push lands

A Worker that has not yet received its first configuration push resolves to your `defaultValue` with
`errorCode: "PROVIDER_NOT_READY"`. That is the one code this surface adds to the shared catalog, and
it is reported rather than disguised: `setup` waits for the applied version precisely so your first
real request is not the one that discovers it.

## Operate it

```bash
splitch cloudflare status --env production   # worker name, endpoint, state, versions, pending deliveries
splitch cloudflare remove --env production   # revoke delivery, unbind SPLITCH, delete the Worker
```

`remove` revokes splitch delivery first, then removes the service binding and the integration Worker.
It never deletes an unrelated Worker or an untracked file.

Targeting keys are hashed with an installation-local key held only in Durable Object storage. A raw
Targeting Key exists in a pending Exposure row only until that row is accepted, terminal, or 24 hours
old.

## Exports

| Import                       | What it is                                                                                                                      |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `@splitch/cloudflare`        | Types only: `SplitchCloudflareService`, `CloudflareEvaluationContext`, `CloudflareResolutionDetails`, `CloudflareRuntimeStatus` |
| `@splitch/cloudflare/worker` | The Worker entrypoint and its `SplitchState` Durable Object; re-exported by the generated `worker.ts`                           |

You do not import `/worker` by hand. `splitch cloudflare setup` generates the entry that does.

## Links

- Cloudflare guide: <https://splitch.dev/docs/sdk/cloudflare>
- CLI reference: <https://splitch.dev/docs/cli>
- Error catalog: <https://splitch.dev/docs#errors>
- Machine-readable index: <https://splitch.dev/llms.txt>
