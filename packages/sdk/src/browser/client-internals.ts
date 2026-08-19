import type { EvaluateAllEntry, VariantValue } from "../generated/contract-surface.js";
import type { SdkResolutionDetails } from "../resolution";
import type { SplitchBrowserClient } from "./client";
import type { HeldResolution } from "./held-resolution";

export type HeldDetailsDecorator = (
  value: VariantValue,
  variantName: string | null,
  reason: SdkResolutionDetails["reason"],
  degraded: boolean,
) => SdkResolutionDetails;

export interface BrowserClientInternalAccess {
  readonly readRevalidationDegraded: () => boolean;
  readonly readHeldEntry: (flagKey: string) => EvaluateAllEntry | undefined;
  readonly deriveHeldResolution: (
    flagKey: string,
    entry: EvaluateAllEntry | undefined,
    defaultValue: VariantValue,
  ) => HeldResolution;
  readonly decorateHeldDetails: HeldDetailsDecorator;
}

const accessByClient = new WeakMap<SplitchBrowserClient, BrowserClientInternalAccess>();

export const decorateHeldDetails: HeldDetailsDecorator = (value, variantName, reason, degraded) => {
  if (degraded) {
    return { value, variantName, reason: "STALE", errorCode: "PROVIDER_NOT_READY" };
  }
  // Return held Variant values by reference. React bindings rely on stable identity.
  return { value, variantName, reason };
};

export function registerBrowserClientInternalAccess(
  client: SplitchBrowserClient,
  access: Omit<BrowserClientInternalAccess, "decorateHeldDetails">,
): void {
  accessByClient.set(
    client,
    Object.freeze({
      ...access,
      decorateHeldDetails,
    }),
  );
}

export function getBrowserClientInternalAccess(
  client: SplitchBrowserClient,
): BrowserClientInternalAccess {
  const access = accessByClient.get(client);
  if (access === undefined) {
    throw new TypeError("Browser client internal access requires a client created by this SDK");
  }
  return access;
}
