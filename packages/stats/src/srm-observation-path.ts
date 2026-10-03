import { zeroCounts } from "./srm-counts";

/**
 * One Entity in the current watermarked population, already filtered to a real
 * arm (not `__multiple__`). The sequential SRM gate rebuilds its look path from
 * these rows on every Results read.
 */
export interface SrmPathEntity {
  readonly targeting_key_hash: string;
  readonly variant: string;
  readonly first_exposure_ts: string;
}

/**
 * Build append-only cumulative arm-count checkpoints by UTC day of each
 * Entity's first Exposure. Within one read the path is monotone by construction;
 * quarantine or late conflict edits the dataset and the next read rebuilds the
 * whole path from the cleaned rows (no cross-read decrease validation).
 *
 * The checkpoint set is exactly the Entities in the pinned-watermark StatsInput,
 * so a pinned read stays deterministic and the result token stays reproducible.
 */
export function buildDailyCumulativeSnapshots(
  entities: readonly SrmPathEntity[],
  variants: readonly string[],
): Readonly<Record<string, number>>[] {
  if (variants.length < 2) {
    throw new Error("SRM observation path requires at least two variants.");
  }

  const byDay = groupEntitiesByUtcDay(entities, variants);
  const days = [...byDay.keys()].sort((left, right) => left.localeCompare(right));
  const cumulative = zeroCounts(variants);
  const snapshots: Record<string, number>[] = [];
  for (const day of days) {
    const dayEntities = byDay.get(day);
    if (dayEntities === undefined) {
      throw new Error(`SRM observation path lost day bucket ${day}.`);
    }
    for (const variant of dayEntities.values()) {
      cumulative[variant] = (cumulative[variant] ?? 0) + 1;
    }
    snapshots.push({ ...cumulative });
  }
  return snapshots;
}

function groupEntitiesByUtcDay(
  entities: readonly SrmPathEntity[],
  variants: readonly string[],
): Map<string, Map<string, string>> {
  const declared = new Set(variants);
  const byDay = new Map<string, Map<string, string>>();
  for (const entity of entities) {
    if (!declared.has(entity.variant)) {
      throw new Error(
        `SRM observation path entity variant ${entity.variant} is missing from allocation.`,
      );
    }
    const day = utcDayKey(entity.first_exposure_ts);
    const dayEntities = byDay.get(day) ?? new Map<string, string>();
    const priorVariant = dayEntities.get(entity.targeting_key_hash);
    if (priorVariant !== undefined && priorVariant !== entity.variant) {
      throw new Error(
        `SRM observation path saw conflicting variants for ${entity.targeting_key_hash} on ${day}.`,
      );
    }
    dayEntities.set(entity.targeting_key_hash, entity.variant);
    byDay.set(day, dayEntities);
  }
  return byDay;
}

function utcDayKey(firstExposureTs: string): string {
  const parsed = Date.parse(firstExposureTs);
  if (!Number.isFinite(parsed)) {
    throw new Error(`first_exposure_ts must be an ISO timestamp; got ${firstExposureTs}`);
  }
  return new Date(parsed).toISOString().slice(0, 10);
}
