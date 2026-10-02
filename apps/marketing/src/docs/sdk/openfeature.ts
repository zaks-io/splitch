import type { SdkTopic } from "./types";

export const openfeatureTopic: SdkTopic = {
  slug: "openfeature",
  title: "OpenFeature and OFREP",
  summary: "Resolve Flags through OFREP and map OpenFeature track() to Metric Events.",
  section: "integration",
  blocks: [
    {
      kind: "prose",
      text: "`@splitch/sdk/openfeature` is an OpenFeature-shaped Provider that talks OFREP Core on the Evaluation Worker. Pass a Client Key or API Key. The Environment comes from the credential.",
    },
    {
      kind: "code",
      lang: "ts",
      code: `import { SplitchOfrepProvider } from "@splitch/sdk/openfeature";

const provider = new SplitchOfrepProvider({
  baseUrl: "https://edge.splitch.dev",
  credential: "pk_...",
});

const details = await provider.resolveBooleanEvaluation("new-checkout", false, {
  targetingKey: user.id,
});`,
    },
    {
      kind: "prose",
      text: "Each typed resolve POSTs `/ofrep/v1/evaluate/flags/{key}` and records Exposure when the Flag is under a live Experiment Run. That request consumes one Evaluation (ADR-0033).",
    },
    {
      kind: "prose",
      text: "`track(eventName, context, details)` submits a Metric Event to `/api/sdk/events`. It needs `context.targetingKey`. Metric Events consume zero Evaluations.",
    },
    { kind: "heading", text: "Bulk prefetch and Exposure" },
    {
      kind: "prose",
      text: "OFREP bulk evaluation (`POST /ofrep/v1/evaluate/flags`) resolves every Flag for one Evaluation Context and bills N Evaluations for N Flags. It does not record Exposure. A fresh live-Run assignment includes `metadata.exposureTicket`. Exposure happens when that ticket is redeemed on first local read, the same rule as `evaluateAll`. Cached local reads consume zero Evaluations.",
    },
  ],
};
