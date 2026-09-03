import type { SdkTopic } from "./types";

export const sentryTopic: SdkTopic = {
  slug: "sentry",
  title: "Sentry",
  summary: "Feed both halves of Sentry's suspect-flag detection: change tracking and evaluations.",
  section: "integration",
  blocks: [
    {
      kind: "prose",
      text: 'Sentry\'s feature-flag support has two independent halves, and its suspect-flag detection ("this Flag flipped four minutes before this error spike") only works when both are fed. Change tracking is server-side and needs no code. Evaluation tracking is a one-line option on your client.',
    },
    {
      kind: "table",
      head: ["Half", "Direction", "Where you set it up"],
      rows: [
        ["Change tracking", "splitch → Sentry", "Control Panel, once per Organization"],
        ["Evaluation tracking", "your app → Sentry", "`@splitch/sdk/sentry` in your app"],
      ],
    },
    {
      kind: "prose",
      text: "Set up change tracking first. An evaluation-tracking-only install shows Flags on the error event but has nothing to correlate them against.",
    },
    { kind: "heading", text: "Change tracking" },
    {
      kind: "prose",
      text: 'Sentry\'s Generic provider form has no "generate secret" button: it asks the provider to supply one. splitch is the provider, so splitch mints the secret and you paste it back. The exchange is two copy-pastes, in this order:',
    },
    {
      kind: "list",
      items: [
        "Copy the webhook URL out of Sentry's **Settings → Feature Flags → Change Tracking → Add New Provider** form.",
        "Paste it into **Organization → Integrations → Sentry change tracking** in the Control Panel and press **Connect Sentry**. The minted signing secret appears once, the same treatment an API Key gets.",
        "Paste that secret into Sentry's Secret field and save.",
      ],
    },
    {
      kind: "prose",
      text: "One installation binds one splitch Organization to one Sentry organization and carries every App and Environment under it. That is Sentry's shape, not a simplification of ours: Sentry keeps a single signing secret per provider type per organization, so two Environments wiring up the same Sentry organization would each mint a secret and the second would silently invalidate the first.",
    },
    {
      kind: "prose",
      text: "The table below the form carries delivery health, **Rotate secret** for when Sentry's copy is lost or compromised, and **Disconnect**, which revokes the installation and stops delivery. Regional hosts (`us.sentry.io`, `de.sentry.io`) are accepted. Every operation is also available on the CLI and over MCP, so an agent can wire this up too.",
    },
    { kind: "heading", text: "Evaluation tracking" },
    { kind: "code", lang: "bash", code: "npm install @sentry/core" },
    {
      kind: "prose",
      text: "`@splitch/sdk/sentry` keeps `@sentry/core` external rather than bundling it, because a second bundled copy would not share a client with the one your app already initialized. Add Sentry's own integration first, then pass the reporter to the SDK's [`onResolution`](/docs/sdk/options) hook.",
    },
    {
      kind: "code",
      lang: "ts",
      code: `import * as Sentry from "@sentry/browser";
import { createSplitchClient } from "@splitch/sdk";
import { sentryResolutionReporter } from "@splitch/sdk/sentry";

Sentry.init({
  dsn: "...",
  integrations: [Sentry.featureFlagsIntegration()],
});

const splitch = createSplitchClient({
  clientKey: "pk_...",
  onResolution: sentryResolutionReporter(),
});`,
    },
    {
      kind: "prose",
      text: "Every resolution the real user path produces now lands in Sentry's flag context, so an error event carries the Flags that were active when it happened. `peekVariant` and `verify` are never reported: they fire no Exposure, and recording them would claim a resolution the user never received.",
    },
    { kind: "heading", text: "How a Variant is encoded" },
    {
      kind: "prose",
      text: "Sentry's flag buffer stores `{ flag, result: boolean }` and its `addFeatureFlag` is a documented no-op for any other value type. That single constraint drives the mapping:",
    },
    {
      kind: "list",
      items: [
        "A boolean resolution passes straight through as `new-checkout = true`.",
        "A multivariate Flag becomes one boolean per served Variant: `checkout:treatment = true`. Two Variants of the same Flag never collide because the Variant is part of the name.",
        "An `ERROR` resolution is not recorded. The Default Variant was served because evaluation failed, and claiming it as a resolution would be exactly the disguised default splitch refuses.",
        "A non-boolean resolution with no Variant name cannot be encoded at all, so it is logged through your `logger` once per Flag Key rather than dropped silently.",
      ],
    },
    {
      kind: "prose",
      text: "If Sentry's `featureFlagsIntegration()` is missing from `Sentry.init`, the reporter says so once per Flag Key with the remediation attached, rather than discarding resolutions into a sink that is not there.",
    },
  ],
};
