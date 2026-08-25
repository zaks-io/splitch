import type { SdkTopic } from "./types";

export const convexTopic: SdkTopic = {
  slug: "convex",
  title: "Convex",
  summary: "Sync Flags for local query and mutation evaluation with @splitch/convex.",
  blocks: [
    {
      kind: "prose",
      text: "Install `@splitch/convex` when queries and mutations need local Flag evaluation. The component syncs configuration into private Convex tables and queues mutation Exposures transactionally.",
    },
    {
      kind: "prose",
      text: "Mount one named component instance per Splitch Environment, then install it once from a Convex Action.",
    },
    {
      kind: "code",
      lang: "ts",
      code: `import splitch from "@splitch/convex/convex.config.js";
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
      text: "Keep the API Key in [Convex environment variables](https://docs.convex.dev/production/environment-variables). `peekVariant` is query-safe and never exposes. `evaluate` is mutation-only and queues an Exposure only when the caller transaction commits.",
    },
    { kind: "heading", text: "Bootstrap in an HTTP action" },
    {
      kind: "prose",
      text: "An HTTP action can mint Precomputed Evaluations for browser hydration. Use an API Key from Convex environment variables and never ship it into client-side code.",
    },
    {
      kind: "code",
      lang: "ts",
      code: `import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { createSplitchClient } from "@splitch/sdk";

const http = httpRouter();

http.route({
  path: "/splitch/bootstrap",
  method: "POST",
  handler: httpAction(async (_ctx, request) => {
    const { targetingKey } = await request.json();
    const splitch = createSplitchClient({
      apiKey: process.env.SPLITCH_API_KEY!,
    });
    const precomputed = await splitch.evaluateAll({ targetingKey });
    return new Response(JSON.stringify(precomputed), {
      headers: { "content-type": "application/json" },
    });
  }),
});

export default http;`,
    },
    {
      kind: "prose",
      text: 'Fail-loud behavior is unchanged in the isolate. Missing credentials throw at construction. Transport failures return `reason: "ERROR"` from `evaluate` and `evaluateDetails`, or throw `SplitchSdkError` from `evaluateAll`.',
    },
  ],
};
