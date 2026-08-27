import type { SdkTopic } from "./types";

export const cloudflareTopic: SdkTopic = {
  slug: "cloudflare",
  title: "Cloudflare Workers",
  summary:
    "Deploy an integration Worker into your own account and evaluate over a service binding.",
  section: "integration",
  blocks: [
    {
      kind: "prose",
      text: "`@splitch/cloudflare` is a Worker you deploy into your own Cloudflare account, backed by a SQLite Durable Object. Configuration is pushed to it from splitch, and your application Workers evaluate Flags and live Experiments against it through a service binding, so no evaluation crosses the public Internet. One deployment is bound to one splitch Environment.",
    },
    {
      kind: "prose",
      text: "Use this when you already run on Workers and want local latency and durable Assignment state. A Worker that is happy with a network round-trip can use the ordinary [server client](/docs/sdk/node) instead.",
    },
    { kind: "heading", text: "Setup" },
    {
      kind: "prose",
      text: "You need Wrangler, an authenticated Cloudflare account, an application `wrangler.jsonc`, and the Environment's API Key exported as `SPLITCH_API_KEY`. The name is exact; setup reads no other variable. Setup checks the Wrangler major itself and names the one it wants if yours is wrong.",
    },
    {
      kind: "code",
      lang: "bash",
      code: `npm install @splitch/cloudflare @splitch/cli
export SPLITCH_API_KEY=sk_...
npx splitch cloudflare setup --env production`,
    },
    {
      kind: "prose",
      text: "The command fails before it mutates anything if the API Key, the application `wrangler.jsonc`, the Wrangler session, or the Cloudflare account is unavailable. Once past that gate it writes `.splitch/cloudflare/production/wrangler.jsonc`, generates an installation id and integration secret, deploys the Worker as `splitch-config-production`, stores `SPLITCH_API_KEY` and `SPLITCH_PUSH_SECRET` as Wrangler secrets, registers the deployment with splitch, waits until the pushed configuration version is applied, and adds the `SPLITCH` service binding to your application's Wrangler environment.",
    },
    {
      kind: "prose",
      text: "The local state file is written mode `0600` and excluded through `.gitignore`. An exact rerun discovers and repairs the existing installation. Reusing the Environment name with a different API Key, Cloudflare account, endpoint, or secret fails [IDEMPOTENCY_KEY_CONFLICT](/docs/error/IDEMPOTENCY_KEY_CONFLICT) rather than quietly rebinding it.",
    },
    { kind: "heading", text: "Evaluate from your Worker" },
    {
      kind: "prose",
      text: "`wrangler types` makes `env.SPLITCH` a typed service binding. The RPC surface is three methods; the same call handles ordinary Flags, Targeting Rules, baseline rollouts, live Experiments, and holdover replay.",
    },
    {
      kind: "code",
      lang: "ts",
      code: `export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const enabled = await env.SPLITCH.evaluate("new-checkout", {
      targetingKey: userId,
      idempotencyKey: crypto.randomUUID(),
      defaultValue: false,
    });

    return new Response(enabled ? "new" : "current");
  },
};`,
    },
    {
      kind: "table",
      head: ["Method", "Returns", "Fires an Exposure"],
      rows: [
        ["`evaluate`", "the Variant value", "yes"],
        ["`evaluateDetails`", "full `ResolutionDetails`", "yes"],
        ["`status`", "installation and delivery health", "no"],
      ],
    },
    {
      kind: "prose",
      text: "`targetingKey` and `idempotencyKey` are required; `idType` defaults to `user`, `attributes` to `{}`, and `defaultValue` to `false`. Both evaluation methods are Exposure-bearing, because an application RPC is an explicit encounter. There is no `remote`, `experiment`, `sendExposure`, or fallback option. Health checks use `status`, never an evaluation accessor.",
    },
    {
      kind: "prose",
      text: "Retrying with the same `idempotencyKey` and identical input returns the stored result and creates no second Exposure. Reusing that key with different input fails loud rather than serving the stale answer.",
    },
    { kind: "heading", text: "Before the first push lands" },
    {
      kind: "prose",
      text: 'A Worker that has not yet received its first configuration push resolves to your `defaultValue` with `errorCode: "PROVIDER_NOT_READY"`. That is the one code the Cloudflare surface adds to the shared catalog, and it is reported rather than disguised: `setup` waits for the applied version precisely so your first real request is not the one that discovers it.',
    },
    { kind: "heading", text: "Operating it" },
    {
      kind: "list",
      items: [
        "`splitch cloudflare status --env production` reports the Worker name, endpoint, installation state, current and applied Environment version, pending delivery count, and the latest bounded error.",
        "`splitch cloudflare remove --env production` revokes splitch delivery first, then removes the service binding and the integration Worker. It never deletes an unrelated Worker or an untracked file.",
      ],
    },
    {
      kind: "prose",
      text: "Targeting keys are hashed with an installation-local key held only in Durable Object storage. A raw Targeting Key exists in a pending Exposure row only until that row is accepted, terminal, or 24 hours old.",
    },
  ],
};
