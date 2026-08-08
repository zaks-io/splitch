import type { EvaluateAllEntry, EvaluateAllReason, Variant } from "@splitch/contracts";
import type { EvaluateResult } from "./evaluate/evaluate-path-types";
import { type MintExposureTicketDeps, mintExposureTicket } from "./evaluate/exposure-ticket";
import type { FlagConfig } from "./provider/provider";

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
      exposureTicket: null,
    };
  }

  const reason = reasonFor(result);
  const exposureTicket =
    result.exposure === null ? null : await mintExposureTicket(result.exposure, ticketDeps);

  return {
    variant: valueForVariantName(flag.variants, result.variant),
    variantName: result.variant,
    reason,
    errorCode: null,
    exposureTicket,
  };
}

function reasonFor(result: Exclude<EvaluateResult, { kind: "error" }>): EvaluateAllReason {
  // Ticket-bearing resolutions are always SPLIT: ADR-0048 mints a ticket exactly
  // when evaluate would seal an Exposure (including live Experiment Run no-match defaults).
  if (result.exposure !== null) return "SPLIT";
  if (result.kind === "disabled") return "DISABLED";
  if (result.kind === "no_match_default" || result.kind === "null_experiment") return "DEFAULT";
  return "SPLIT";
}

function valueForVariantName(
  variants: readonly Variant[],
  variantName: string | null,
): Variant["value"] | null {
  if (variantName === null) return null;
  const variant = variants.find((item) => item.name === variantName);
  return variant === undefined ? null : variant.value;
}
