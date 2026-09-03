import type { FeatureFlagsIntegration } from "@sentry/core";
import { getClient } from "@sentry/core";
import type { Logger } from "../evaluate";
import type { SdkResolutionDetails } from "../resolution";

/**
 * Mirrors splitch resolutions into Sentry's feature-flag context, so an error
 * event carries the Flags that were active when it happened and Sentry's
 * suspect-flag detection has something to correlate against.
 *
 * Sentry's flag buffer stores `{ flag: string, result: boolean }` and its
 * `addFeatureFlag` is a documented no-op for any other value type (see
 * `_INTERNAL_insertToFlagBuffer` in `@sentry/core`). That single constraint
 * drives every mapping below: a multivariate resolution has to become a boolean
 * or it silently vanishes inside Sentry.
 *
 * Pair with the change-tracking half (splitch POSTs flag changes to Sentry's
 * generic provider hook); suspect-flag detection needs both.
 */

/** The name `featureFlagsIntegration()` registers itself under. */
const INTEGRATION_NAME = "FeatureFlags";

export interface SentryResolutionReporterOptions {
  /** Where setup problems are reported. Defaults to `console`. */
  readonly logger?: Logger;
}

/**
 * Build the `onResolution` callback for {@link createSplitchClient}.
 *
 * ```ts
 * const client = createSplitchClient({
 *   clientKey,
 *   onResolution: sentryResolutionReporter(),
 * });
 * ```
 *
 * Requires `Sentry.featureFlagsIntegration()` in the host app's `Sentry.init`.
 */
export function sentryResolutionReporter(
  options: SentryResolutionReporterOptions = {},
): (flagKey: string, details: SdkResolutionDetails) => void {
  const logger = options.logger ?? console;
  const reported = new Set<string>();

  return (flagKey, details) => {
    // The Default Variant was served because evaluation failed. Recording it
    // would claim a resolution that never happened (the disguised default
    // ADR-0036 forbids), and the exception Sentry is already capturing carries
    // the real story.
    if (details.reason === "ERROR") return;

    const integration =
      getClient()?.getIntegrationByName<FeatureFlagsIntegration>(INTEGRATION_NAME);
    if (!integration) {
      once(
        reported,
        logger,
        "@splitch/sdk/sentry: no Sentry FeatureFlags integration is installed",
        {
          remediation:
            "Add Sentry.featureFlagsIntegration() to the integrations passed to Sentry.init",
          flagKey,
        },
      );
      return;
    }

    if (typeof details.value === "boolean") {
      integration.addFeatureFlag(flagKey, details.value);
      return;
    }

    // A multivariate Flag becomes one boolean per served Variant: `checkout:treatment
    // = true`. Sentry then reads it as an ordinary flag, and two Variants of the
    // same Flag never collide because the Variant is part of the name.
    if (details.variantName !== null) {
      integration.addFeatureFlag(`${flagKey}:${details.variantName}`, true);
      return;
    }

    once(
      reported,
      logger,
      "@splitch/sdk/sentry: a non-boolean resolution with no Variant cannot be sent to Sentry",
      {
        remediation:
          "Sentry stores booleans only; a Flag serving a non-boolean Default Variant has no arm name to encode",
        flagKey,
        reason: details.reason,
      },
    );
  };
}

/**
 * One report per distinct key. A dropped resolution is a real gap in the flag
 * context, so it is never silent, but a per-evaluation log would drown the
 * host app's console on the very first busy page.
 */
function once(
  seen: Set<string>,
  logger: Logger,
  message: string,
  detail: { readonly flagKey: string; readonly remediation: string; readonly reason?: string },
): void {
  const key = `${message}::${detail.flagKey}`;
  if (seen.has(key)) return;
  seen.add(key);
  logger.error(message, detail);
}
