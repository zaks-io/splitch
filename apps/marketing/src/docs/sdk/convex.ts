import type { SdkTopic } from "./types";

export const convexTopic: SdkTopic = {
  slug: "convex",
  title: "Convex",
  summary: "Evaluate in actions and create browser bootstrap in HTTP actions.",
  blocks: [
    {
      kind: "prose",
      text: "Convex's default runtime is a custom V8 isolate with no Node built-ins. `fetch` is available in [actions](https://docs.convex.dev/functions/actions) and [HTTP actions](https://docs.convex.dev/functions/http-actions), not in queries or mutations.",
    },
    {
      kind: "prose",
      text: "Call `@splitch/sdk` from an action, then hand the result to queries or mutations as ordinary data.",
    },
    {
      kind: "code",
      lang: "ts",
      code: `import { createSplitchClient } from "@splitch/sdk";
import { action } from "./_generated/server";
import { v } from "convex/values";

export const evaluateFlag = action({
  args: {
    flagKey: v.string(),
    targetingKey: v.string(),
    idempotencyKey: v.string(),
  },
  handler: async (_ctx, args) => {
    const splitch = createSplitchClient({
      clientKey: process.env.SPLITCH_CLIENT_KEY!,
      endpoint: process.env.SPLITCH_ENDPOINT,
    });
    return await splitch.evaluate(args.flagKey, {
      targetingKey: args.targetingKey,
      idempotencyKey: args.idempotencyKey,
      defaultValue: false,
    });
  },
});`,
    },
    {
      kind: "prose",
      text: "This server-side action uses a Client Key because `evaluate` fires an Exposure. Keep the credential in [Convex environment variables](https://docs.convex.dev/production/environment-variables).",
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
