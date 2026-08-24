import type { SdkTopic } from "./types";

export const evaluateAllTopic: SdkTopic = {
  slug: "evaluate-all",
  title: "evaluateAll and bootstrap",
  summary: "Resolve every Flag once, then hydrate a browser client without another fetch.",
  blocks: [
    {
      kind: "prose",
      text: "`evaluateAll(context)` resolves every Flag in the credential's App and Environment for one Evaluation Context. It returns the normalized context, an `evaluations` map keyed by Flag Key, and the strong `ETag` that tagged the result.",
    },
    {
      kind: "code",
      lang: "ts",
      code: `import { createSplitchClient } from "@splitch/sdk";

const splitch = createSplitchClient({ apiKey: "sk_..." });
const precomputed = await splitch.evaluateAll({ targetingKey: user.id });

precomputed.context;
precomputed.evaluations;
precomputed.etag;`,
    },
    {
      kind: "prose",
      text: "The call fires no Exposure. A fresh assignment in a live experiment Run carries an `exposureTicket` instead. The browser client redeems that ticket only when it reads the Flag, so a page that holds 20 Flags and shows 3 records 3 Exposures.",
    },
    {
      kind: "prose",
      text: "The payload contains resolved values, Variant names, non-revealing reasons, and tickets. It never contains Targeting Rules, rollout percentages, or the salt.",
    },
    { kind: "heading", text: "Bootstrap a browser client" },
    {
      kind: "prose",
      text: "Generate Precomputed Evaluations on the server with an API Key, serialize that exact result into the page, then construct the browser client with the matching Evaluation Context and the public Client Key. A valid bootstrap makes `init()` perform no fetch.",
    },
    {
      kind: "code",
      lang: "ts",
      code: `import { createSplitchBrowserClient } from "@splitch/sdk/browser";

const splitch = createSplitchBrowserClient({
  clientKey: "pk_...",
  context: precomputed.context,
  bootstrap: precomputed,
});

await splitch.init();`,
    },
    {
      kind: "prose",
      text: "Bootstrap echoes the Evaluation Context, including `targetingKey` and every attribute you passed. It becomes public page source. Pass only attributes you would publish, and hash or omit the rest.",
    },
    {
      kind: "prose",
      text: "Bootstrap must carry the exact normalized Evaluation Context used by the browser client. A mismatch throws `SDK_BOOTSTRAP_CONTEXT_MISMATCH` during construction instead of silently fetching another Entity's result.",
    },
    { kind: "heading", text: "Failure and idempotency" },
    {
      kind: "prose",
      text: "`idempotencyKey` is optional because the SDK mints one per fetch. Pass your own when retrying an uncertain fetch. If `crypto.randomUUID` is unavailable, the SDK throws `SDK_IDEMPOTENCY_KEY_UNAVAILABLE` and requires you to supply the key.",
    },
    {
      kind: "prose",
      text: "Unlike `evaluate`, this call has no Default Variant. It throws `SplitchSdkError` on failure instead of returning a partial or empty payload.",
    },
  ],
};
