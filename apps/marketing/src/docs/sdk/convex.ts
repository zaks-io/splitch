import type { SdkTopic } from "./types";

export const convexTopic: SdkTopic = {
  slug: "convex",
  title: "Convex",
  summary: "Local Flag evaluation inside Queries and Mutations, with transactional Exposures.",
  section: "integration",
  blocks: [
    { kind: "code", lang: "bash", code: "npm install @splitch/convex" },
    {
      kind: "prose",
      text: "`@splitch/convex` is the first-party Convex Component. Configuration is synced into component-private tables, so a Query can resolve a Flag with no network access, and a Mutation can put the resulting Exposure into a transactional outbox alongside your application writes. It installs `@splitch/sdk`, which owns the shared local evaluator.",
    },
    { kind: "heading", text: "Mount the component" },
    {
      kind: "code",
      lang: "ts",
      code: `// convex/convex.config.ts
import splitch from "@splitch/convex/convex.config.js";
import { defineApp } from "convex/server";
import { v } from "convex/values";

const app = defineApp({ env: { SPLITCH_API_KEY: v.string() } });

app.use(splitch, {
  httpPrefix: "/integrations/splitch/",
  env: { SPLITCH_API_KEY: app.env.SPLITCH_API_KEY },
});

export default app;`,
    },
    {
      kind: "prose",
      text: "Keep the API Key in [Convex environment variables](https://docs.convex.dev/production/environment-variables). It stays in the deployment environment and must never reach browser code. The configuration callback is served at `/integrations/splitch/configuration`.",
    },
    { kind: "heading", text: "Evaluate" },
    {
      kind: "prose",
      text: "Bind the component once with the `Splitch` class, then use it from Queries and Mutations. `peekVariant` and `peekDetails` are query-safe and fire no Exposure. `evaluate` and `evaluateDetails` are Mutation-only and queue an Exposure that is discarded if the caller's transaction rolls back.",
    },
    {
      kind: "code",
      lang: "ts",
      code: `// convex/flags.ts
import { Splitch } from "@splitch/convex";
import { v } from "convex/values";
import { components } from "./_generated/api";
import { mutation, query } from "./_generated/server";

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
});`,
    },
    { kind: "heading", text: "Install from an Action" },
    {
      kind: "prose",
      text: "Call `flags.install(ctx)` from an Action after mounting the component, and again after upgrading `@splitch/convex`. The request is idempotent. On upgrade it adopts Exposure delivery work left by the previous version, resumes stale configuration sync, and schedules retention for existing rows.",
    },
    {
      kind: "code",
      lang: "ts",
      code: `// convex/setup.ts
import { Splitch } from "@splitch/convex";
import { components } from "./_generated/api";
import { action } from "./_generated/server";

const flags = new Splitch(components.splitch);

export const install = action({
  args: {},
  handler: (ctx) => flags.install(ctx),
});`,
    },
    {
      kind: "prose",
      text: "`flags.sync(ctx)` forces a configuration pull, `flags.rotateSecret(ctx)` mints a new push secret, and `flags.uninstall(ctx)` revokes the remote installation before purging the component's private state. All four are Action-only.",
    },
    { kind: "heading", text: "React" },
    {
      kind: "prose",
      text: "Component functions are private to the Convex backend, so expose an app-owned public Query that performs your authentication and derives the Evaluation Context server-side. Never take the targeting key from the client.",
    },
    {
      kind: "code",
      lang: "ts",
      code: `// convex/flags.ts
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
});`,
    },
    {
      kind: "prose",
      text: "Bind that generated Query once with `createSplitchReact`, then use the hooks under Convex's existing provider.",
    },
    {
      kind: "code",
      lang: "tsx",
      code: `import { createSplitchReact } from "@splitch/convex/react";
import { api } from "../convex/_generated/api";

const { useFlag, useFlagDetails } = createSplitchReact(api.flags.resolve);

export function Checkout() {
  const enabled = useFlag("new-checkout", false);
  if (enabled === undefined) return <p>Loading…</p>;
  return enabled ? <NewCheckout /> : <CurrentCheckout />;
}`,
    },
    {
      kind: "prose",
      text: "Both hooks preserve Convex's `undefined` loading state and update reactively when the synced snapshot changes. They are non-exposing reads: record the Exposure by calling `flags.evaluate()` in the Mutation where the Variant is actually encountered, alongside the write it controls.",
    },
    { kind: "heading", text: "Deletion and retention" },
    {
      kind: "prose",
      text: "`flags.deleteEntity(ctx, { targetingKey, idType })` inside a Mutation removes one Entity's local holdovers and queued Exposures. Background recovery is activity-driven: the component registers no cron jobs and invokes nothing periodically while idle.",
    },
    {
      kind: "prose",
      text: 'Fail-loud behavior is unchanged in the isolate. A missing credential throws at installation, and a resolution that could not be computed reports `reason: "ERROR"` with its `errorCode` rather than returning a plausible value.',
    },
  ],
};
