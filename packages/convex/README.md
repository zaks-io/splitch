# @splitch/convex

The first-party Convex Component for local Splitch Flag evaluation. Configuration is synced into
component-private tables, so a Query can resolve a Flag with no network access, and a Mutation can
put the resulting Exposure or Metric Event into a transactional outbox alongside your application
writes. It installs `@splitch/sdk`, which owns the shared local evaluator and contract types.

- Full guide: <https://splitch.dev/docs/sdk/convex>
- Every failure code, with its cause and its fix: <https://splitch.dev/docs/errors>

## Install

```bash
npm install @splitch/convex
```

Peers: `convex` >= 1.43, and `react` 18 or 19 if you use `@splitch/convex/react`.

## Mount the component

```ts
// convex/convex.config.ts
import splitch from "@splitch/convex/convex.config.js";
import { defineApp } from "convex/server";
import { v } from "convex/values";

const app = defineApp({ env: { SPLITCH_API_KEY: v.string() } });

app.use(splitch, {
  httpPrefix: "/integrations/splitch/",
  env: { SPLITCH_API_KEY: app.env.SPLITCH_API_KEY },
});

export default app;
```

Keep the API Key in [Convex environment variables](https://docs.convex.dev/production/environment-variables).
It stays in the deployment environment and must never reach browser code. The configuration callback
is served at `/integrations/splitch/configuration`.

The component also accepts an optional `SPLITCH_ENDPOINT` to point at a non-production splitch edge;
it defaults to `https://edge.splitch.dev`.

## Install from an Action

Call `flags.install(ctx)` from an Action after mounting the component, and again after upgrading
`@splitch/convex`. The request is idempotent. On upgrade it starts one bounded adoption chain for
Exposure and Metric Event delivery work created by the previous version, resumes stale configuration
sync, and schedules retention for existing retained rows.

The API Key you mount must carry both data-plane scopes. `data-plane:evaluate` covers evaluation;
`data-plane:write` covers Metric Event delivery. `install` checks this and refuses a Key minted for
evaluation alone, naming the missing scope, rather than letting every later `track()` fail
asynchronously where you would not see it.

```bash
splitch api-keys create --env production \
  --body-json '{"scopes":["data-plane:evaluate","data-plane:write"]}'
```

```ts
// convex/setup.ts
import { Splitch } from "@splitch/convex";
import { components } from "./_generated/api";
import { action } from "./_generated/server";

const flags = new Splitch(components.splitch);

export const install = action({ args: {}, handler: (ctx) => flags.install(ctx) });
```

## Evaluate

Bind the component once with the `Splitch` class, then use it from Queries and Mutations.

| Method            | Context           | Returns                  | Fires an Exposure |
| ----------------- | ----------------- | ------------------------ | ----------------- |
| `peekVariant`     | Query or Mutation | the Variant value        | no                |
| `peekDetails`     | Query or Mutation | full `ResolutionDetails` | no                |
| `evaluate`        | Mutation          | the Variant value        | yes               |
| `evaluateDetails` | Mutation          | full `ResolutionDetails` | yes               |

The Exposure an Exposure-bearing call queues is discarded if the caller's transaction rolls back,
which is why `evaluate` is Mutation-only: record it where the Variant is actually encountered,
alongside the write it controls.

```ts
// convex/flags.ts
import { Splitch } from "@splitch/convex";
import { components } from "./_generated/api";
import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

const flags = new Splitch(components.splitch);

export const checkoutEnabled = query({
  args: { targetingKey: v.string() },
  returns: v.boolean(),
  handler: (ctx, args) =>
    flags.peekVariant(ctx, "new-checkout", { targetingKey: args.targetingKey }, false),
});

export const completeCheckout = mutation({
  args: { targetingKey: v.string(), idempotencyKey: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const enabled = await flags.evaluate(
      ctx,
      "new-checkout",
      { targetingKey: args.targetingKey, idempotencyKey: args.idempotencyKey },
      false,
    );
    if (typeof enabled !== "boolean") throw new Error("new-checkout must be boolean");
    return enabled;
  },
});
```

`idType` defaults to `user` and `attributes` to `{}`. The fourth argument is the Default Variant this
call falls back to; a resolution that could not be computed reports `reason: "ERROR"` with its
`errorCode` rather than returning a plausible value.

## Metric Events

`flags.track(ctx, eventName, event)` queues one Metric Event from a Mutation, so the record of the
outcome commits or rolls back with the write that produced it. Call it in the same Mutation that
persists the thing being measured.

```ts
export const completeCheckout = mutation({
  args: { eventId: v.string(), targetingKey: v.string(), revenue: v.number(), plan: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.insert("orders", { targetingKey: args.targetingKey, revenue: args.revenue });
    await flags.track(ctx, "checkout_completed", {
      targetingKey: args.targetingKey,
      idType: "user",
      eventId: args.eventId,
      fields: { revenue: args.revenue },
      dimensions: { plan: args.plan },
    });
    return null;
  },
});
```

You own the `eventId`: one lowercase UUID per logical Metric Event, reused when the Mutation is
retried. `fields` carries the measured values the Event Definition declares. `dimensions` carries the
low-cardinality slice labels (`boolean | string | number`) results break down by.

`track` returns `{ eventId, queued: true }`. That receipt says the delivery intent joined your Convex
transaction, and nothing more; it is not an acceptance. Splitch validates the Event Definition and
payload when the queued row is delivered, which happens outside your Mutation.

Malformed input is refused inside the Mutation rather than queued: `eventName` must be a 1 to 64
character telemetry token, `eventId` a lowercase UUID, every number finite, and the whole event at
most 32 KiB of UTF-8. Reusing an `eventId` with different content throws `EVENT_ID_CONFLICT`; an
exact replay returns the original receipt and queues nothing new.

### Following a delivery

```ts
const status = await flags.trackStatus(ctx, eventId);
```

| State        | Means                                                                       |
| ------------ | --------------------------------------------------------------------------- |
| `missing`    | no Metric Event was ever queued under this `eventId`                        |
| `queued`     | accepted into the outbox, delivery not yet confirmed                        |
| `accepted`   | Splitch accepted it                                                         |
| `terminal`   | delivery stopped; `error` carries the reason Splitch gave                   |
| `suppressed` | an Entity deletion arrived first, so the event was dropped rather than sent |

`trackStatus` reads from a Query or a Mutation. Delivery retries with backoff on a retryable failure
(408, 429, 5xx) and goes terminal on anything else. It also goes terminal if it has not succeeded
within 24 hours, which is the same privacy deadline that bounds how long the raw Targeting Key is
retained.

## React

Component functions are private to the Convex backend, so expose an app-owned public Query that
performs your authentication and derives the Evaluation Context server-side. Never take the targeting
key from the client.

```ts
// convex/flags.ts
export const resolve = query({
  args: { flagKey: v.string(), defaultValue: v.any() },
  returns: v.any(),
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Authentication is required to evaluate Flags");
    return flags.peekDetails(
      ctx,
      args.flagKey,
      { targetingKey: identity.tokenIdentifier },
      args.defaultValue,
    );
  },
});
```

Bind that generated public Query once, then use the hooks under Convex's existing provider:

```tsx
import { createSplitchReact } from "@splitch/convex/react";
import { api } from "../convex/_generated/api";

const { useFlag, useFlagDetails } = createSplitchReact(api.flags.resolve);

export function Checkout() {
  const enabled = useFlag("new-checkout", false);
  if (enabled === undefined) return <p>Loading…</p>;
  return enabled ? <NewCheckout /> : <CurrentCheckout />;
}
```

Both hooks preserve Convex's `undefined` loading state and update reactively when the synced snapshot
changes. They are non-exposing reads: record the Exposure with `flags.evaluate()` in the Mutation
where the Variant is encountered.

## Operate it

These four are Action-only:

| Call                      | What it does                                                         |
| ------------------------- | -------------------------------------------------------------------- |
| `flags.install(ctx)`      | Register (or repair) the installation. Idempotent; rerun on upgrade. |
| `flags.sync(ctx)`         | Force a configuration pull; returns the applied Environment version. |
| `flags.rotateSecret(ctx)` | Mint a new push secret for the configuration callback.               |
| `flags.uninstall(ctx)`    | Revoke the remote installation, then purge component-private state.  |

`flags.deleteEntity(ctx, { targetingKey, idType })` inside a Mutation removes one Entity's local
holdovers and suppresses its queued Exposures and Metric Events.

Background recovery is activity-driven. Configuration nudges and new Exposure or Metric Event outbox
rows schedule their own recovery mutations, which stop once the work is complete. Retained claims and
completed Exposure and Metric Event rows share one scheduled cleanup job set for the earliest expiry.
The component registers no cron jobs and invokes nothing periodically while idle.

## When to use `@splitch/sdk` instead

Queries and Mutations cannot call `fetch`, which is why this component exists. Use `@splitch/sdk`
directly from an Action or HTTP Action when a request-time round-trip is what you actually want, or
to mint Precomputed Evaluations for SSR hydration. See <https://splitch.dev/docs/sdk/convex>.

The SDK's `track()` is the Action-side counterpart of this component's: it awaits the platform's
answer and throws on rejection. The component's commits a queued delivery inside your transaction
and reports the outcome through `trackStatus`. Prefer the component's from a Mutation, so the
Metric Event cannot survive a write that rolled back.

## Links

- Convex guide: <https://splitch.dev/docs/sdk/convex>
- SDK guide: <https://splitch.dev/docs/sdk/install>
- Error catalog: <https://splitch.dev/docs/errors>
- Machine-readable index: <https://splitch.dev/llms.txt>
