import type { SdkTopic } from "./types";

export const methodsTopic: SdkTopic = {
  slug: "methods",
  title: "The six methods",
  summary: "Which calls fire an Exposure, and which credential each needs.",
  section: "guide",
  blocks: [
    {
      kind: "prose",
      text: "An Exposure is the “this subject saw this Variant” event that experiment analysis counts. Which methods fire one is the core thing to get right: an Exposure recorded outside the real user path inflates the denominator and biases the result.",
    },
    {
      kind: "table",
      head: ["Method", "Returns", "Fires an Exposure", "Credential"],
      rows: [
        ["`evaluate`", "the Variant value", "yes", "Client Key only"],
        ["`evaluateDetails`", "full `ResolutionDetails`", "yes", "Client Key only"],
        ["`peekVariant`", "the Variant value", "no", "API Key only"],
        ["`verify`", "full `ResolutionDetails`", "no", "Client Key or API Key"],
        ["`evaluateAll`", "every Flag, in one round trip", "no", "Client Key or API Key"],
        [
          "`track`",
          "the accepted Metric Event",
          "no",
          "Client Key, or an API Key with `data-plane:write`",
        ],
      ],
    },
    {
      kind: "list",
      items: [
        "`evaluate` or `evaluateDetails` on the real user path. These are the calls that belong in production request handling; reach for `evaluateDetails` when the handler needs `ResolutionDetails`.",
        "`peekVariant` to inspect a resolution without polluting experiment data: admin screens, support tooling, debugging.",
        "`verify` to confirm setup end to end. Same shape as `evaluateDetails`, no Exposure, safe to run repeatedly in CI.",
        "`evaluateAll` to render a whole page from one request. Each fresh assignment under a live Run carries an Exposure Ticket that a client redeems when it actually reads that Flag, so a page holding 20 Flags and showing 3 records 3 Exposures.",
        "`track` to append the Metric Event an experiment measures. It is the other half of the pair: Exposures are the denominator, Metric Events are the numerator.",
      ],
    },
    { kind: "heading", text: "Reading ResolutionDetails" },
    {
      kind: "prose",
      text: "`evaluateDetails` and `verify` return the reason the value was chosen, not just the value. Branch on `reason` when you need to distinguish a real resolution from a fallback.",
    },
    {
      kind: "code",
      lang: "ts",
      code: `const details = await splitch.evaluateDetails("new-checkout", {
  targetingKey: user.id,
  idempotencyKey: crypto.randomUUID(),
  defaultValue: false,
});

if (details.reason === "ERROR") {
  // details.value is your defaultValue, and details.errorCode says why.
  // Every code is documented at https://splitch.dev/docs/error/{code}
}`,
    },
    { kind: "heading", text: "Recording a Metric Event" },
    {
      kind: "prose",
      text: "`track` appends one Metric Event against an Event Definition you declared beforehand. You own the `eventId` and reuse it when retrying, exactly as `idempotencyKey` works for evaluation; a replay comes back with `duplicate: true` and appends nothing.",
    },
    {
      kind: "code",
      lang: "ts",
      code: `const result = await splitch.track("checkout_completed", {
  targetingKey: user.id,
  idType: "user",
  eventId: crypto.randomUUID(),
  fields: { revenue: 42.5 },
  dimensions: { plan: "pro" },
});

result.duplicate; // true when this eventId was already appended`,
    },
    {
      kind: "prose",
      text: "Unlike `evaluate`, `track` has no Default Variant to fall back to, so it throws `SplitchSdkError` on rejection rather than returning a partial result. An undeclared `eventName`, a payload that fails the Event Definition, or a credential without `data-plane:write` all surface as a throw naming the code.",
    },
  ],
};

export const idempotencyTopic: SdkTopic = {
  slug: "idempotency",
  title: "idempotencyKey",
  summary: "One key per logical evaluation. Reuse it to retry safely.",
  section: "guide",
  blocks: [
    {
      kind: "prose",
      text: "`evaluate` and `evaluateDetails` require `idempotencyKey`: a caller-owned id for one logical evaluation. Generate it once per evaluation with `crypto.randomUUID()`.",
    },
    {
      kind: "prose",
      text: "If a request's outcome is uncertain (a timeout, a dropped connection), resend it with the same key. The platform deduplicates the Exposure, so the subject is counted once. This is why the SDK refuses `retries`: an automatic retry with a fresh key is a second Exposure for one logical evaluation, and it double-counts the subject in every experiment reading that Flag.",
    },
    {
      kind: "prose",
      text: "The key is yours, not ours. Deriving it from something stable in your own request context (a request id, a job id) makes retries idempotent by construction.",
    },
    {
      kind: "list",
      items: [
        "[IDEMPOTENCY_KEY_CONFLICT](/docs/error/IDEMPOTENCY_KEY_CONFLICT) on the control plane means one key was reused with a different payload. Use a fresh key for a different change, or resend the original payload unchanged.",
        "[SDK_RETRIES_INVALID](/docs/error/SDK_RETRIES_INVALID) is thrown at construction when `retries` is set above `0`.",
      ],
    },
  ],
};

export const failuresTopic: SdkTopic = {
  slug: "failures",
  title: "Failure behavior",
  summary:
    "Server evaluation never throws on a runtime failure and never hides one. It does throw on caller misconfiguration, like a missing idempotencyKey. Peek throws, and so does a browser read before init().",
  section: "guide",
  blocks: [
    {
      kind: "prose",
      text: "A failure is always observable and never a silently disguised default. That is the whole contract; the shape it takes depends on the method.",
    },
    { kind: "heading", text: "evaluate, evaluateDetails, verify" },
    {
      kind: "prose",
      text: 'On the server client these never throw on a runtime failure and never retry. On any platform failure (HTTP error, timeout, network error, unparseable body) they return your `defaultValue` (or `false` when you gave none), log loudly through `logger.error`, and report `reason: "ERROR"` plus an `errorCode` in `ResolutionDetails`. `evaluate` and `evaluateDetails` also throw `SplitchSdkError` if the context omits a required `idempotencyKey` — that is caller misconfiguration, not a runtime failure.',
    },
    {
      kind: "prose",
      text: "The default value is returned so your request path keeps serving, and the loud log plus the `ERROR` reason are what stop that from becoming a silent outage. If you only read the value, you cannot tell a resolved `false` from a fallback `false`: read `reason` when the difference matters.",
    },
    { kind: "heading", text: "The browser client has one throw" },
    {
      kind: "prose",
      text: "The browser client resolves from a payload it fetched in `init()`, so there is nothing to fall back to until that payload exists. `evaluate`, `evaluateDetails`, and the `useFlag` / `useFlagDetails` hooks throw [SDK_NOT_INITIALIZED](/docs/error/SDK_NOT_INITIALIZED) when they are read before `init()` resolves, and `init()` itself throws on a failed fetch. Once it has resolved, reads follow the rule above and never throw: a revalidation failure marks the payload degraded rather than clearing it.",
    },
    {
      kind: "prose",
      text: "In React that throw surfaces during render, so await `init()` before mounting `SplitchProvider`, or render the tree behind an error boundary.",
    },
    { kind: "heading", text: "peekVariant" },
    {
      kind: "prose",
      text: "Throws a `SplitchSdkError` carrying `code`, `status`, and `docsUrl`. Peek is an inspection call with no user path to keep serving, so failing loudly is the correct behavior rather than returning something plausible.",
    },
    { kind: "heading", text: "Reading the error" },
    {
      kind: "prose",
      text: "Every `SplitchSdkError` message is one line in a fixed shape, and every code resolves to a page:",
    },
    {
      kind: "code",
      lang: "text",
      code: "UNAUTHORIZED: Cause: <what happened>. Remediation: <what to do>. Docs: https://splitch.dev/docs/error/UNAUTHORIZED",
    },
    {
      kind: "prose",
      text: "The full catalog is at [/docs/errors](/docs/errors), and the machine-readable index is at [/llms.txt](/llms.txt).",
    },
  ],
};

export const dedupTopic: SdkTopic = {
  slug: "exposure-dedup",
  title: "Exposure dedup",
  summary: "Repeat evaluations replay locally. Run boundaries do not.",
  section: "guide",
  blocks: [
    {
      kind: "prose",
      text: 'Repeat `evaluate` calls for the same Flag and `targetingKey` within the revalidation window (`revalidateMs`, default 60 seconds) replay locally with `reason: "CACHED"` and fire no second Exposure. Rendering a component twice in one page load counts the subject once.',
    },
    {
      kind: "prose",
      text: "When a new experiment Run starts, the SDK detects the boundary within that window and fires a fresh Exposure. A Run is the unit analysis is computed over, so an Exposure suppressed across a Run boundary would attribute the subject to the wrong Run.",
    },
    {
      kind: "prose",
      text: "Errors are never cached. A failed resolution replayed from cache would turn one outage into a window of them with no new signal.",
    },
    { kind: "heading", text: "Bounding the seen set" },
    {
      kind: "prose",
      text: "Dedup state is an in-memory seen set bounded by `maxSize` and a TTL. Both must be positive; a zero or negative bound would disable dedup without saying so, which is exactly the silent-default failure the SDK refuses.",
    },
    {
      kind: "prose",
      text: "Telemetry for a replayed local resolution is reported separately. If that report cannot be delivered you get [SDK_CACHED_TELEMETRY_FAILED](/docs/error/SDK_CACHED_TELEMETRY_FAILED). The value your code received is unaffected; it is surfaced so a telemetry gap never reads as an absence of traffic.",
    },
  ],
};
