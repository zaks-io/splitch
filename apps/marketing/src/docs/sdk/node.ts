import { sdkNodeMajor } from "../package-facts";
import type { SdkTopic } from "./types";

export const nodeTopic: SdkTopic = {
  slug: "node",
  title: "Node.js",
  summary: "Evaluate on the request path from a Node server, with one client for the process.",
  section: "integration",
  blocks: [
    { kind: "code", lang: "bash", code: "npm install @splitch/sdk" },
    {
      kind: "prose",
      text: `Node ${sdkNodeMajor} or newer. The package is ESM only, so a CommonJS project reaches it through \`await import("@splitch/sdk")\`. Construction performs no I/O, so build the client once at module scope and share it for the life of the process: a client per request throws away the local Exposure-dedup cache and re-counts subjects that a shared client would have collapsed.`,
    },
    {
      kind: "code",
      lang: "ts",
      code: `// splitch.ts
import { createSplitchClient } from "@splitch/sdk";

const clientKey = process.env.SPLITCH_CLIENT_KEY;
if (!clientKey) throw new Error("SPLITCH_CLIENT_KEY is required");

export const splitch = createSplitchClient({ clientKey });`,
    },
    {
      kind: "prose",
      text: "Throwing on a missing credential is deliberate. A client constructed without one throws `SDK_CREDENTIAL_CONFIGURATION_INVALID` anyway, and failing at import time puts the error in the boot log rather than in the first user's request.",
    },
    { kind: "heading", text: "On the request path" },
    {
      kind: "prose",
      text: "A Client Key is what a server uses to evaluate. It is public by design and safe on a server; the secret API Key cannot call `evaluate` at all. Mint one `idempotencyKey` per logical evaluation and derive it from something stable in the request when you can.",
    },
    {
      kind: "code",
      lang: "ts",
      code: `import express from "express";
import { splitch } from "./splitch";

const app = express();

app.get("/checkout", async (req, res) => {
  const enabled = await splitch.evaluate("new-checkout", {
    targetingKey: req.user.id,
    idempotencyKey: req.id,
    defaultValue: false,
  });

  res.send(enabled ? renderNewCheckout() : renderCurrentCheckout());
});`,
    },
    {
      kind: "prose",
      text: 'This call never throws on a runtime failure and never retries. On any platform failure it returns your `defaultValue`, logs through `logger.error`, and reports `reason: "ERROR"` in `evaluateDetails`. Your handler keeps serving; the loud log is what stops that from becoming a silent outage. It does throw if the context omits a required `idempotencyKey` — that is a caller bug, not a runtime failure. See [Failure behavior](/docs/sdk/failures).',
    },
    { kind: "heading", text: "Rendering a page in one round trip" },
    {
      kind: "prose",
      text: "A server-rendered page that reads many Flags should not make one request per Flag. `evaluateAll` resolves every Flag in the credential's App and Environment at once and fires no Exposure; each fresh assignment carries an Exposure Ticket the browser redeems on first read. Serialize the result into the page and hand it to the [browser client](/docs/sdk/browser) as `bootstrap`. See [evaluateAll and bootstrap](/docs/sdk/evaluate-all).",
    },
    { kind: "heading", text: "Keep it off the user path" },
    {
      kind: "prose",
      text: "Admin screens, support tooling, and debugging read a Flag with `peekVariant`, which fires no Exposure and needs an API Key. Recording an Exposure outside the real user path inflates the experiment's denominator and biases the result, so the two calls are deliberately separate methods on separate credentials.",
    },
    {
      kind: "prose",
      text: "CI and deploy checks use `verify`: the same shape as `evaluateDetails`, no Exposure, safe to run repeatedly on either credential.",
    },
  ],
};
