import type { EvaluateAllEntry, Variant } from "@splitch/contracts";
import type { EvaluateResult } from "./evaluate/evaluate-path-types";
import {
  type MintExposureTicketDeps,
  mintExposureTicketWithIdentity,
} from "./evaluate/exposure-ticket";
import type { FlagConfig } from "./provider/provider";
import { reasonForResolution } from "./resolution-reason";

export async function entryFor(
  result: EvaluateResult,
  flag: FlagConfig,
  ticketDeps: MintExposureTicketDeps,
): Promise<EvaluateAllEntry> {
  if (result.kind === "error") {
    return {
      variant: valueForVariantName(flag.variants, result.variant),
      variantName: result.variant,
      reason: "ERROR",
      errorCode: result.errorCode,
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
    variant: valueForVariantName(flag.variants, result.variant),
    variantName: result.variant,
    reason,
    errorCode: null,
    ...minted,
  };
}

function valueForVariantName(
  variants: readonly Variant[],
  variantName: string | null,
): Variant["value"] | null {
  if (variantName === null) return null;
  const variant = variants.find((item) => item.name === variantName);
  return variant === undefined ? null : variant.value;
}
