# @splitch/convex

The first-party Convex Component for local Splitch Flag evaluation. Configuration is synced into
component-private tables. Queries can peek without network access. Mutations can evaluate and put
the resulting Exposure into a transactional outbox alongside application writes.

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
  handler: (ctx, args) =>
    flags.peekVariant(ctx, "new-checkout", { targetingKey: args.targetingKey }, false),
});

export const completeCheckout = mutation({
  args: { targetingKey: v.string(), idempotencyKey: v.string() },
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

Call `flags.install(ctx)` once from an Action after mounting the component. The callback is served at
`/integrations/splitch/configuration`. `SPLITCH_API_KEY` stays in the Convex deployment environment
and must never be sent to browser code.

Use `flags.deleteEntity(ctx, { targetingKey, idType })` inside a Mutation to remove one Entity's
local holdovers and queued Exposures. `flags.uninstall(ctx)` revokes the remote installation before
purging the component's private state.
