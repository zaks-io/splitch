import type { EvaluateAllEntry, Variant } from "@splitch/contracts";
import type { EvaluateResult } from "./evaluate/evaluate-path-types";
import {
  type MintExposureTicketDeps,
  mintExposureTicketWithIdentity,
} from "./evaluate/exposure-ticket";
import type { FlagConfig } from "./provider/provider";
import { reasonForResolution } from "./resolution-reason";

export function resolutionEntry(
  result: EvaluateResult,
  flag: FlagConfig,
): Omit<EvaluateAllEntry, "exposureIdentity" | "exposureTicket"> & {
  readonly exposureIdentity: null;
  readonly exposureTicket: null;
} {
  if (result.kind === "error") {
    return {
      variant: null,
      variantName: result.variant,
      reason: "ERROR",
      errorCode: result.errorCode,
      exposureIdentity: null,
      exposureTicket: null,
    };
  }
  const value = valueForVariantName(flag.variants, result.variant);
  if (!value.ok) {
    return {
      variant: null,
      variantName: value.variantName,
      reason: "ERROR",
      errorCode: "INTERNAL_SERVER_ERROR",
      exposureIdentity: null,
      exposureTicket: null,
    };
  }
  return {
    variant: value.value,
    variantName: result.variant,
    reason: reasonForResolution(result),
    errorCode: null,
    exposureIdentity: null,
    exposureTicket: null,
  };
}

export async function entryFor(
  result: EvaluateResult,
  flag: FlagConfig,
  ticketDeps: MintExposureTicketDeps,
): Promise<EvaluateAllEntry> {
  if (result.kind === "error") {
    return {
      variant: null,
      variantName: result.variant,
      reason: "ERROR",
      errorCode: result.errorCode,
      exposureIdentity: null,
      exposureTicket: null,
    };
  }

  const value = valueForVariantName(flag.variants, result.variant);
  if (!value.ok) {
    return {
      variant: null,
      variantName: value.variantName,
      reason: "ERROR",
      errorCode: "INTERNAL_SERVER_ERROR",
      exposureIdentity: null,
      exposureTicket: null,
    };
  }

  const reason = reasonForResolution(result);
  const minted =
    result.exposure === null
      ? { exposureIdentity: null, exposureTicket: null }
      : await mintExposureTicketWithIdentity(result.exposure, ticketDeps);

  return {
    variant: value.value,
    variantName: result.variant,
    reason,
    errorCode: null,
    ...minted,
  };
}

function valueForVariantName(
  variants: readonly Variant[],
  variantName: string | null,
): { ok: true; value: Variant["value"] | null } | { ok: false; variantName: string } {
  if (variantName === null) return { ok: true, value: null };
  const variant = variants.find((item) => item.name === variantName);
  return variant === undefined ? { ok: false, variantName } : { ok: true, value: variant.value };
}
