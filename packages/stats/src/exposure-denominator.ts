import type { ActivationRow, DedupeExposureRow } from "@splitch/contracts";

export const MULTIPLE_VARIANT = "__multiple__";

export interface ExposureDenominatorInput {
  readonly run_id: string;
  readonly variant: string;
  readonly exposures: readonly DedupeExposureRow[];
}

export interface AnalysisExposureInput {
  readonly run_id: string;
  readonly exposures: readonly DedupeExposureRow[];
  readonly activation_rows?: readonly ActivationRow[];
}

interface ActivatedExposureInput {
  readonly run_id: string;
  readonly exposures: readonly DedupeExposureRow[];
  readonly activation_rows: readonly ActivationRow[];
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

export function analysisExposureRows(input: AnalysisExposureInput): DedupeExposureRow[] {
  if (input.activation_rows === undefined) {
    // Filter to THIS run and drop `__multiple__`, matching the activated branch:
    // foreign-run rows would otherwise inflate dimension-slice sample sizes,
    // suppress low-N warnings, and mint phantom slices from prior runs.
    return input.exposures.filter(
      (exposure) => exposure.run_id === input.run_id && exposure.variant !== MULTIPLE_VARIANT,
    );
  }

  return activatedExposureRows({
    run_id: input.run_id,
    exposures: input.exposures,
    activation_rows: input.activation_rows,
  });
}

export function activatedExposureRows(input: ActivatedExposureInput): DedupeExposureRow[] {
  const entities = new Map<string, DedupeExposureRow>();
  const activationsByEntity = activationRowsByEntity(input.run_id, input.activation_rows);

  for (const exposure of input.exposures) {
    if (
      exposure.run_id !== input.run_id ||
      exposure.variant === MULTIPLE_VARIANT ||
      !isActivatedAfterExposure(exposure, activationsByEntity)
    ) {
      continue;
    }

    entities.set(`${exposure.variant}/${exposure.targeting_key_hash}`, exposure);
  }

  return [...entities.values()];
}

function activationRowsByEntity(
  runId: string,
  rows: readonly ActivationRow[],
): Map<string, ActivationRow[]> {
  const byEntity = new Map<string, ActivationRow[]>();
  for (const row of rows) {
    if (row.run_id !== runId || !row.activated) {
      continue;
    }

    const existing = byEntity.get(row.targeting_key_hash) ?? [];
    existing.push(row);
    byEntity.set(row.targeting_key_hash, existing);
  }
  return byEntity;
}

function isActivatedAfterExposure(
  exposure: DedupeExposureRow,
  activationsByEntity: ReadonlyMap<string, readonly ActivationRow[]>,
): boolean {
  const activations = activationsByEntity.get(exposure.targeting_key_hash) ?? [];
  return activations.some(
    (activation) =>
      timestampMs(activation.activation_ts, "activation_ts") >
      timestampMs(exposure.first_exposure_ts, "first_exposure_ts"),
  );
}

function timestampMs(value: string, field: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${field} must be an ISO timestamp.`);
  }
  return parsed;
}
