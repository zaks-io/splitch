import { sdkNodeMajor } from "../package-facts";
import type { SdkTopic } from "./types";

export const installTopic: SdkTopic = {
  slug: "install",
  title: "Install",
  summary: "Add @splitch/sdk, read the export surface, and get one Flag resolving.",
  section: "guide",
  blocks: [
    { kind: "code", lang: "bash", code: "npm install @splitch/sdk" },
    {
      kind: "prose",
      text: `\`@splitch/sdk\` is ESM only and supports Node ${sdkNodeMajor} or newer, browsers, Cloudflare Workers, and other edge runtimes. Pick the runtime guide for your host: [Node.js](/docs/sdk/node), [Browser client](/docs/sdk/browser), [React bindings](/docs/sdk/react), [Convex](/docs/sdk/convex), [Cloudflare Workers](/docs/sdk/cloudflare), or [Sentry](/docs/sdk/sentry).`,
    },
    { kind: "heading", text: "Export surface" },
    {
      kind: "table",
      head: ["Import", "What it is", "Extra install"],
      rows: [
        ["`@splitch/sdk`", "server client: evaluate, peek, verify, evaluateAll, track", "none"],
        ["`@splitch/sdk/browser`", "static-context browser client with synchronous reads", "none"],
        ["`@splitch/sdk/react`", "`SplitchProvider` and the `useFlag` hooks", "`react`"],
        [
          "`@splitch/sdk/sentry`",
          "mirror resolutions into Sentry's flag context",
          "`@sentry/core`",
        ],
        [
          "`@splitch/sdk/local-evaluation`",
          "the local evaluator the Convex component runs on",
          "`zod`",
        ],
        [
          "`@splitch/sdk/control-plane`",
          "typed control-plane client and contract schemas",
          "`zod`",
        ],
      ],
    },
    {
      kind: "prose",
      text: "The three evaluation entrypoints (`.`, `./browser`, `./react`) bundle their implementation and pull in no runtime dependency, so adding the SDK to an app adds nothing to its dependency tree beyond React if you use the hooks. `./sentry`, `./local-evaluation`, and `./control-plane` deliberately leave theirs external: a second bundled copy of `@sentry/core` would not share a client with the host app's, and a second `zod` would not share schema identity.",
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
  section: "guide",
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
          "`evaluate`, `evaluateDetails`, `verify`, `evaluateAll`, `track`",
        ],
        [
          "`apiKey`",
          "secret API Key (`sk_`)",
          "servers only; never ship it to a client",
          "`peekVariant`, `verify`, `evaluateAll`, `track`",
        ],
      ],
    },
    {
      kind: "prose",
      text: "A server-side integration that fires Exposures uses a Client Key, not an API Key. The API Key cannot call `evaluate` or `evaluateDetails`. Client Keys are safe to use from servers, so present one on that path.",
    },
    { kind: "heading", text: "Scopes" },
    {
      kind: "prose",
      text: "The data plane has two scopes. A Client Key carries both of them, which is why it can `track` as well as evaluate. An API Key carries whichever you enumerate at `splitch api-keys create`, so an API Key minted for evaluation alone is refused by `track`.",
    },
    {
      kind: "table",
      head: ["Scope", "Covers"],
      rows: [
        [
          "`data-plane:evaluate`",
          "`evaluate`, `evaluateDetails`, `peekVariant`, `verify`, `evaluateAll`",
        ],
        ["`data-plane:write`", "`track`, the Metric Event append"],
      ],
    },
    { kind: "heading", text: "What a rejected credential looks like" },
    {
      kind: "list",
      items: [
        "[UNAUTHORIZED](/docs/error/UNAUTHORIZED): no credential, or one that could not be parsed.",
        "[CREDENTIAL_REVOKED](/docs/error/CREDENTIAL_REVOKED): known key, revoked. Revocation is immediate; it never degrades to cached service.",
        "[INSUFFICIENT_SCOPES](/docs/error/INSUFFICIENT_SCOPES): valid key without the scope this call needs. The failure names `requiredScopes` and the scopes the key actually holds.",
        "[ORIGIN_NOT_ALLOWED](/docs/error/ORIGIN_NOT_ALLOWED): valid Client Key from an origin not on its allow-list.",
        "[APP_MISMATCH](/docs/error/APP_MISMATCH): the key belongs to a different App than the request addressed.",
      ],
    },
  ],
};

export const optionsTopic: SdkTopic = {
  slug: "options",
  title: "Options",
  summary: "endpoint, timeoutMs, retries, logger, transport, onResolution.",
  section: "guide",
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
        ["`fetch`", "the global `fetch`", "injectable seam for tests and custom agents"],
        ["`now`", "`Date.now`", "injectable epoch-ms clock"],
        ["`revalidateMs`", "`60000`", "Exposure-dedup window; a new Run is detected within it"],
        ["`seenSetMaxSize`", "bounded default", "max entries in the local Exposure-dedup cache"],
        ["`onResolution`", "unset", "observability hook; see below"],
      ],
    },
    { kind: "heading", text: "onResolution" },
    {
      kind: "prose",
      text: "`onResolution(flagKey, details)` is called with every resolution the real user path produced, for observability sinks that want to know which Flags were active. It is never called for `peekVariant` or `verify`, because those fire no Exposure and reporting them would claim a resolution the user never received.",
    },
    {
      kind: "prose",
      text: "It is called synchronously and never awaited, and a throwing reporter is not caught: an observability sink that fails should fail where it fails rather than be swallowed into a silently degraded evaluation. [Sentry](/docs/sdk/sentry) ships a ready-made reporter for this hook.",
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
