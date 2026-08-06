import type { SdkTopic } from "./types";

export const installTopic: SdkTopic = {
  slug: "install",
  title: "Install",
  summary: "Add @splitch/sdk and get one Flag resolving.",
  blocks: [
    { kind: "code", lang: "bash", code: "npm install @splitch/sdk" },
    {
      kind: "prose",
      text: "ESM only. Node 20 or newer, browsers, and edge runtimes. `zod` is the sole dependency.",
    },
    { kind: "heading", text: "Hello world" },
    {
      kind: "prose",
      text: "Paste the `keyMaterial` field from `splitch client-key get` (a `pk_…` value). The response's `keyId` (`ck_…`) identifies the key; it is not the credential.",
    },
    {
      kind: "code",
      lang: "ts",
      code: `import { createSplitchClient } from "@splitch/sdk";

const splitch = createSplitchClient({ clientKey: "pk_..." });

const variant = await splitch.evaluate("new-checkout", {
  targetingKey: user.id,
  idempotencyKey: crypto.randomUUID(),
  defaultValue: false,
});`,
    },
    {
      kind: "prose",
      text: "That is one HTTP call. There is no local config file to sync and no background poller: the resolution and the Exposure it records happen in the same round-trip.",
    },
    {
      kind: "prose",
      text: "To create the App, Environment, and Flag this needs, run the [platform quickstart](/quickstart) first.",
    },
  ],
};

export const credentialsTopic: SdkTopic = {
  slug: "credentials",
  title: "Credentials",
  summary: "Client Key evaluates, API Key peeks. Pass exactly one.",
  blocks: [
    {
      kind: "prose",
      text: "Construct the client with exactly one credential. Zero or both throws `SDK_CREDENTIAL_CONFIGURATION_INVALID` at construction, because the two unlock different methods and the client cannot guess which you meant.",
    },
    {
      kind: "table",
      head: ["Option", "Credential", "Where it may live", "Unlocks"],
      rows: [
        [
          "`clientKey`",
          "public Client Key (`pk_`)",
          "browsers, mobile, servers: anything that evaluates",
          "`evaluate`, `evaluateDetails`, `verify`, `evaluateAll`",
        ],
        [
          "`apiKey`",
          "secret API Key (`sk_`)",
          "servers only; never ship it to a client",
          "`peekVariant`, `verify`, `evaluateAll`",
        ],
      ],
    },
    {
      kind: "prose",
      text: "A server-side integration that fires Exposures uses a Client Key, not an API Key. The API Key cannot call `evaluate` or `evaluateDetails`. Client Keys are safe to use from servers, so present one on that path.",
    },
    { kind: "heading", text: "What a rejected credential looks like" },
    {
      kind: "list",
      items: [
        "[UNAUTHORIZED](/docs/error/UNAUTHORIZED): no credential, or one that could not be parsed.",
        "[CREDENTIAL_REVOKED](/docs/error/CREDENTIAL_REVOKED): known key, revoked. Revocation is immediate; it never degrades to cached service.",
        "[INSUFFICIENT_SCOPES](/docs/error/INSUFFICIENT_SCOPES): valid key without the scope this call needs. A Client Key holds only `evaluate`.",
        "[ORIGIN_NOT_ALLOWED](/docs/error/ORIGIN_NOT_ALLOWED): valid Client Key from an origin not on its allow-list.",
        "[APP_MISMATCH](/docs/error/APP_MISMATCH): the key belongs to a different App than the request addressed.",
      ],
    },
  ],
};

export const optionsTopic: SdkTopic = {
  slug: "options",
  title: "Options",
  summary: "endpoint, timeoutMs, retries, logger, transport.",
  blocks: [
    {
      kind: "prose",
      text: "Every option is documented in the shipped type declarations (`dist/index.d.ts`). These are the ones worth knowing before you read them.",
    },
    {
      kind: "table",
      head: ["Option", "Default", "Notes"],
      rows: [
        ["`endpoint`", "`https://edge.splitch.dev`", "override for self-hosted or preview targets"],
        ["`timeoutMs`", "`5000`", "per-call timeout; a timeout is an ERROR, not a default"],
        ["`retries`", "`0`", "must stay `0`; reuse `idempotencyKey` instead"],
        ["`logger`", "`console`", "receives every fail-loud report"],
        ["`transport`", "built-in `fetch` adapter", "injectable seam for tests"],
      ],
    },
    { kind: "heading", text: "Options that throw" },
    {
      kind: "prose",
      text: "These are validated at construction so a misconfigured client fails on the first line rather than corrupting Exposure data at request time.",
    },
    {
      kind: "list",
      items: [
        "[SDK_RETRIES_INVALID](/docs/error/SDK_RETRIES_INVALID): `retries` is anything but `0`.",
        "[SDK_SEEN_SET_MAX_SIZE_INVALID](/docs/error/SDK_SEEN_SET_MAX_SIZE_INVALID): the dedup seen-set bound is not a positive integer.",
        "[SDK_SEEN_SET_TTL_INVALID](/docs/error/SDK_SEEN_SET_TTL_INVALID): the dedup TTL is not a positive duration.",
      ],
    },
  ],
};
