import type { SdkTopic } from "./types";

export const browserTopic: SdkTopic = {
  slug: "browser",
  title: "Browser client",
  summary: "Fetch once, read Flags synchronously, and fire Exposures on first use.",
  section: "integration",
  blocks: [
    {
      kind: "prose",
      text: "`@splitch/sdk/browser` provides a static-context browser client. It holds one Evaluation Context for its lifetime, fetches Precomputed Evaluations once, and makes synchronous Flag reads with no per-read network request.",
    },
    {
      kind: "code",
      lang: "ts",
      code: `import { createSplitchBrowserClient } from "@splitch/sdk/browser";

const splitch = createSplitchBrowserClient({
  clientKey: "pk_...",
  context: { targetingKey: user.id },
  revalidateMs: 60_000,
});

await splitch.init();

const enabled = splitch.evaluate("new-checkout", false);
const details = splitch.evaluateDetails("new-checkout", false);
await splitch.flush();`,
    },
    {
      kind: "prose",
      text: "The browser client accepts a public Client Key. Secret credentials throw at construction. Reading before `init()` resolves throws `SDK_NOT_INITIALIZED`.",
    },
    {
      kind: "prose",
      text: 'The first local read of a Flag redeems its Exposure Ticket and queues one Exposure. `flush()` acknowledges delivery. An unknown Flag returns the caller\'s Default Variant with `reason: "ERROR"`, `FLAG_NOT_FOUND`, and a loud log.',
    },
    { kind: "heading", text: "Bootstrap and revalidation" },
    {
      kind: "prose",
      text: "Pass a server `evaluateAll` result as `bootstrap` to make reads available immediately and prevent an initial fetch. See [evaluateAll and bootstrap](/docs/sdk/evaluate-all) for the server and browser boundary.",
    },
    {
      kind: "prose",
      text: "The client revalidates with `If-None-Match` every 60 seconds by default. Set `revalidateMs` to `0` to disable polling. A `304` keeps the current payload; a changed response swaps it atomically and notifies subscribers only for changed Flags.",
    },
    {
      kind: "prose",
      text: "Failed revalidation logs on every attempt and keeps serving the last-known-good values as `STALE` with `PROVIDER_NOT_READY` until recovery. Call `close()` to stop polling.",
    },
    { kind: "heading", text: "Exposure delivery" },
    {
      kind: "prose",
      text: "`flush()` drains the Exposure queue. Retryable delivery failures make at most three automatic attempts. A non-retryable 4xx stops automatic delivery after its first attempt. Both terminal paths log loudly, retain the items, and leave them available for an explicit `flush()`.",
    },
  ],
};
