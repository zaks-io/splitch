import * as Sentry from "@sentry/node";
import { createSplitchClient } from "@splitch/sdk";
import { sentryResolutionReporter } from "@splitch/sdk/sentry";

/**
 * Evaluation tracking: which Flags were active when this error happened.
 *
 * `featureFlagsIntegration()` is what buffers the flags onto the event. Without
 * it the reporter has nowhere to write and says so loudly on the first
 * resolution.
 */
Sentry.init({
  dsn: required("SENTRY_DSN"),
  integrations: [Sentry.featureFlagsIntegration()],
});

const splitch = createSplitchClient({
  clientKey: required("SPLITCH_CLIENT_KEY"),
  // Unset points at splitch's own edge; set it for a preview or self-hosted one.
  endpoint: process.env.SPLITCH_ENDPOINT,
  onResolution: sentryResolutionReporter(),
});

// `idempotencyKey` scopes Exposure dedup to one encounter; a real app derives it
// from the request or session it is serving.
const encounter = { targetingKey: "user-42", idempotencyKey: "checkout-page-load-1" };

// Boolean Flag: attached to the event as `new-checkout = <value>`.
const newCheckout = await splitch.evaluate("new-checkout", { ...encounter, defaultValue: false });

// Multivariate Flag: attached as `checkout-flow:<variantName> = true`, because
// Sentry's flag buffer stores booleans and drops anything else.
const checkoutFlow = await splitch.evaluateDetails("checkout-flow", {
  ...encounter,
  defaultValue: "control",
});

console.log({ newCheckout, checkoutFlow: checkoutFlow.variantName });

// Sentry's Feature Flags section on this issue should list both flags, and once
// change tracking is installed (see README) it marks a recently toggled one suspect.
Sentry.captureException(new Error("checkout failed after flag rollout"));
await Sentry.flush(2000);

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required; see examples/sentry/README.md`);
  return value;
}
