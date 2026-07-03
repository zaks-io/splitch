import type { DedupeExposureRow } from "@splitch/contracts";

export const MULTIPLE_VARIANT = "__multiple__";

export interface ExposureDenominatorInput {
  readonly run_id: string;
  readonly variant: string;
  readonly exposures: readonly DedupeExposureRow[];
}

export function dedupedExposureRowsForVariant(
  input: ExposureDenominatorInput,
): DedupeExposureRow[] {
  const entities = new Map<string, DedupeExposureRow>();
  for (const exposure of input.exposures) {
    if (
      exposure.run_id !== input.run_id ||
      exposure.variant !== input.variant ||
      exposure.variant === MULTIPLE_VARIANT
    ) {
      continue;
    }
    entities.set(exposure.targeting_key_hash, exposure);
  }

  return [...entities.values()];
}
