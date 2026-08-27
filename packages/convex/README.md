# @splitch/convex

The first-party Convex Component for local Splitch Flag evaluation. Configuration is synced into
component-private tables. Queries can peek without network access. Mutations can put Exposures and
Metric Events into transactional outboxes alongside application writes.
It installs `@splitch/sdk`, which owns the shared local evaluator and contract types.

```bash
npm install @splitch/convex
```

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

Call `flags.install(ctx)` from an Action after mounting the component and again after upgrading
`@splitch/convex`. The installation request is idempotent. On upgrade, it starts one bounded adoption
chain for Exposure delivery work created by the previous version, resumes stale configuration sync,
and schedules retention for existing retained rows. The callback is served at
`/integrations/splitch/configuration`. `SPLITCH_API_KEY` stays in the Convex deployment environment
and must never be sent to browser code.

Background recovery is activity-driven. Configuration nudges and new Exposure or Metric Event
outbox rows schedule their own recovery mutations, which stop once the work is complete. Retained
claims and terminal Exposure rows share one scheduled cleanup job set for the earliest expiry. The
component registers no cron jobs and invokes nothing periodically while idle.

Use `flags.deleteEntity(ctx, { targetingKey, idType })` inside a Mutation to remove one Entity's
local holdovers and queued Exposures or Metric Events. `flags.uninstall(ctx)` revokes the remote
installation before purging the component's private state.

## Metric Events

Call `track()` inside the same Mutation that persists the application outcome being measured. The
caller owns one lowercase UUID per logical Metric Event and reuses it if the Mutation is retried.

```ts
export const saveGeneration = mutation({
  args: {
    eventId: v.string(),
    targetingKey: v.string(),
    tokenCount: v.number(),
    model: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.insert("generations", {
      targetingKey: args.targetingKey,
      tokenCount: args.tokenCount,
      model: args.model,
    });
    await flags.track(ctx, "model-generation", {
      targetingKey: args.targetingKey,
      idType: "user",
      eventId: args.eventId,
      fields: { generationCount: 1, tokenCount: args.tokenCount },
      dimensions: { model: args.model },
    });
    return null;
  },
});
```

`{ eventId, queued: true }` confirms only that the delivery intent joined the caller's Convex
transaction. It does not claim that Splitch accepted the Event Definition or payload. Delivery is
asynchronous. `trackStatus(ctx, eventId)` returns `queued`, `accepted`, `terminal`, `suppressed`, or
`missing`; terminal responses include the safe error returned by Splitch. Exact retries reuse the
existing delivery. Reusing an ID for different content throws `EVENT_ID_CONFLICT`.

## React

Component functions are private to the Convex backend, so expose an app-owned public Query that
performs your authentication and derives the Evaluation Context server-side:

```ts
// convex/flags.ts
import { Splitch } from "@splitch/convex";
import { v } from "convex/values";
import { components } from "./_generated/api";
import { query } from "./_generated/server";

const flags = new Splitch(components.splitch);

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

Bind the generated public Query once, then use the hooks under Convex's existing provider:

```tsx
import { createSplitchReact } from "@splitch/convex/react";
import { api } from "../convex/_generated/api";

const { useFlag, useFlagDetails } = createSplitchReact(api.flags.resolve);

export function Checkout() {
  const enabled = useFlag("new-checkout", false);
  const details = useFlagDetails("new-checkout", false);
  if (enabled === undefined || details === undefined) return <p>Loading…</p>;
  return enabled ? <NewCheckout /> : <CurrentCheckout />;
}
```

Both hooks preserve Convex's `undefined` loading state and reactively update when the component
snapshot changes. They are non-exposing Query reads. Record an Exposure by calling
`flags.evaluate()` inside the Mutation where the Variant is actually encountered or alongside the
application write it controls.
