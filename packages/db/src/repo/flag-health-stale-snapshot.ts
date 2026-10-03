import { and, eq, inArray, max, type SQL } from "drizzle-orm";
import { experiments, flagChangeEvents, flagConfigs, targetingRules } from "../schema/index";
import type { Db } from "./client";
import {
  legacyRunsProbeQuery,
  mapRunLifecycleRows,
  runLifecycleQueries,
  type RunLifecycleAggregateRow,
} from "./flag-health-run-history";
import { idBatches, twoAxisIdBatches } from "./id-batches";
import { assertMintedScope, type TenantScope, withTenantScope } from "./scope";
import { crossEnvironmentPredicate } from "./scoped-table-read";

const CHANGE_SCOPE = {
  appId: flagChangeEvents.appId,
  appIdKey: "appId",
} as const;

const FLAG_CONFIG_SCOPE = {
  appId: flagConfigs.appId,
  appIdKey: "appId",
  environmentId: flagConfigs.environmentId,
  environmentIdKey: "environmentId",
} as const;

const TARGETING_RULE_SCOPE = {
  appId: targetingRules.appId,
  appIdKey: "appId",
  environmentId: targetingRules.environmentId,
  environmentIdKey: "environmentId",
} as const;

const EXPERIMENT_SCOPE = {
  appId: experiments.appId,
  appIdKey: "appId",
  environmentId: experiments.environmentId,
  environmentIdKey: "environmentId",
} as const;

type StaleConfigRow = {
  flagId: string;
  environmentId: string;
  enabled: boolean;
  rollout: string | null;
  updatedAt: string;
};

type StaleRuleScopeRow = {
  flagId: string;
  environmentId: string;
};

type StaleRunningExperimentRow = {
  flagId: string;
  environmentId: string;
};

export type StaleDetectionSnapshot = {
  configs: StaleConfigRow[];
  targetingRules: StaleRuleScopeRow[];
  runningExperiments: StaleRunningExperimentRow[];
  runLifecycleByScope: Map<string, string>;
  lastChangeByFlag: Map<string, string>;
  hasInWindowLegacyRuns: boolean;
};

type LatestChangeRow = {
  flagId: string;
  lastChangedAt: string | null;
};

function requireSql(value: SQL | undefined, label: string): SQL {
  if (!value) throw new Error(`flag-health-stale-snapshot: ${label} produced no SQL`);
  return value;
}

function latestChangeQueries(db: Db, scope: TenantScope, flagIds: readonly string[]) {
  assertMintedScope(scope);
  return idBatches(flagIds).map((batch) =>
    db
      .select({
        flagId: flagChangeEvents.flagId,
        lastChangedAt: max(flagChangeEvents.changedAt),
      })
      .from(flagChangeEvents)
      .where(
        withTenantScope(
          CHANGE_SCOPE,
          scope,
          requireSql(inArray(flagChangeEvents.flagId, batch), "latest change flagIds"),
        ),
      )
      .groupBy(flagChangeEvents.flagId),
  );
}

function mapLatestChangeRows(rows: readonly LatestChangeRow[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const row of rows) {
    if (row.lastChangedAt === null) {
      throw new Error(
        `latestChangeAtByFlagId: Flag ${row.flagId} has change-log rows but no changedAt`,
      );
    }
    out.set(row.flagId, row.lastChangedAt);
  }
  return out;
}

/** Latest change-log `changedAt` for the given Flag ids only. */
export async function loadLatestChangeAtByFlagIds(
  db: Db,
  scope: TenantScope,
  flagIds: readonly string[],
): Promise<Map<string, string>> {
  if (flagIds.length === 0) return new Map();
  const pages = await Promise.all(latestChangeQueries(db, scope, flagIds));
  return mapLatestChangeRows(pages.flat());
}

function crossEnvironmentQueries<T>(
  batches: ReturnType<typeof twoAxisIdBatches<string, string>>,
  build: (flagBatch: string[], environmentBatch: string[]) => T,
): T[] {
  return batches.map(({ first, second }) => build(first, second));
}

function emptyStaleDetectionSnapshot(): StaleDetectionSnapshot {
  return {
    configs: [],
    targetingRules: [],
    runningExperiments: [],
    runLifecycleByScope: new Map(),
    lastChangeByFlag: new Map(),
    hasInWindowLegacyRuns: false,
  };
}

function flattenBatchPages<T>(pages: readonly unknown[], expected: number, label: string): T[] {
  if (pages.length !== expected) {
    throw new Error(
      `loadStaleDetectionSnapshot: expected ${expected} ${label} pages, got ${pages.length}`,
    );
  }
  return pages.flatMap((page) => page as T[]);
}

function takeBatchPages(
  results: readonly unknown[],
  offset: number,
  count: number,
): { pages: readonly unknown[]; nextOffset: number } {
  const nextOffset = offset + count;
  return { pages: results.slice(offset, nextOffset), nextOffset };
}

function staleConfigQueries(
  db: Db,
  scope: TenantScope,
  axisBatches: ReturnType<typeof twoAxisIdBatches<string, string>>,
) {
  return crossEnvironmentQueries(axisBatches, (flagBatch, environmentBatch) => {
    const predicate = crossEnvironmentPredicate(
      FLAG_CONFIG_SCOPE,
      scope,
      environmentBatch,
      inArray(flagConfigs.flagId, flagBatch),
    );
    if (!predicate) {
      throw new Error("loadStaleDetectionSnapshot: config predicate missing for non-empty ids");
    }
    return db
      .select({
        flagId: flagConfigs.flagId,
        environmentId: flagConfigs.environmentId,
        enabled: flagConfigs.enabled,
        rollout: flagConfigs.rollout,
        updatedAt: flagConfigs.updatedAt,
      })
      .from(flagConfigs)
      .where(predicate);
  });
}

function staleRuleQueries(
  db: Db,
  scope: TenantScope,
  axisBatches: ReturnType<typeof twoAxisIdBatches<string, string>>,
) {
  return crossEnvironmentQueries(axisBatches, (flagBatch, environmentBatch) => {
    const predicate = crossEnvironmentPredicate(
      TARGETING_RULE_SCOPE,
      scope,
      environmentBatch,
      inArray(targetingRules.flagId, flagBatch),
    );
    if (!predicate) {
      throw new Error("loadStaleDetectionSnapshot: rule predicate missing for non-empty ids");
    }
    return db
      .select({
        flagId: targetingRules.flagId,
        environmentId: targetingRules.environmentId,
      })
      .from(targetingRules)
      .where(predicate);
  });
}

function staleRunningExperimentQueries(
  db: Db,
  scope: TenantScope,
  axisBatches: ReturnType<typeof twoAxisIdBatches<string, string>>,
) {
  return crossEnvironmentQueries(axisBatches, (flagBatch, environmentBatch) => {
    const predicate = crossEnvironmentPredicate(
      EXPERIMENT_SCOPE,
      scope,
      environmentBatch,
      and(eq(experiments.status, "running"), inArray(experiments.flagId, flagBatch)),
    );
    if (!predicate) {
      throw new Error("loadStaleDetectionSnapshot: experiment predicate missing for non-empty ids");
    }
    return db
      .select({
        flagId: experiments.flagId,
        environmentId: experiments.environmentId,
      })
      .from(experiments)
      .where(predicate);
  });
}

/**
 * Configuration, Targeting Rules, running Experiments, Run lifecycle, and
 * change-log evidence for a live stale page in one D1 batch. Concurrent rule
 * removal (or Run End) cannot split those independent reads into a premature
 * `uniform_serving` signal.
 */
export async function readStaleDetectionSnapshot(
  db: Db,
  scope: TenantScope,
  flagIds: readonly string[],
  environmentIds: readonly string[],
  windowStartIso: string,
): Promise<StaleDetectionSnapshot> {
  assertMintedScope(scope);
  if (flagIds.length === 0 || environmentIds.length === 0) {
    return emptyStaleDetectionSnapshot();
  }

  const axisBatches = twoAxisIdBatches(flagIds, environmentIds);
  const configQueries = staleConfigQueries(db, scope, axisBatches);
  const ruleQueries = staleRuleQueries(db, scope, axisBatches);
  const experimentQueries = staleRunningExperimentQueries(db, scope, axisBatches);
  const lifecycleQueries = runLifecycleQueries(db, scope, flagIds, environmentIds);
  const changeQueries = latestChangeQueries(db, scope, flagIds);
  const legacyQuery = legacyRunsProbeQuery(db, scope, windowStartIso);

  const statements = [
    ...configQueries,
    ...ruleQueries,
    ...experimentQueries,
    ...lifecycleQueries,
    ...changeQueries,
    legacyQuery,
  ];
  const results = await db.batch(statements as unknown as Parameters<Db["batch"]>[0]);

  let offset = 0;
  const configs = takeBatchPages(results, offset, configQueries.length);
  offset = configs.nextOffset;
  const rules = takeBatchPages(results, offset, ruleQueries.length);
  offset = rules.nextOffset;
  const running = takeBatchPages(results, offset, experimentQueries.length);
  offset = running.nextOffset;
  const lifecycle = takeBatchPages(results, offset, lifecycleQueries.length);
  offset = lifecycle.nextOffset;
  const changes = takeBatchPages(results, offset, changeQueries.length);
  offset = changes.nextOffset;
  const legacy = takeBatchPages(results, offset, 1);
  offset = legacy.nextOffset;
  if (offset !== results.length) {
    throw new Error(
      `loadStaleDetectionSnapshot: batch result length ${results.length} != statement count ${offset}`,
    );
  }

  const legacyRows = flattenBatchPages<{ id: string }>(legacy.pages, 1, "legacy-run");
  return {
    configs: flattenBatchPages<StaleConfigRow>(configs.pages, configQueries.length, "config"),
    targetingRules: flattenBatchPages<StaleRuleScopeRow>(
      rules.pages,
      ruleQueries.length,
      "targeting-rule",
    ),
    runningExperiments: flattenBatchPages<StaleRunningExperimentRow>(
      running.pages,
      experimentQueries.length,
      "running-experiment",
    ),
    runLifecycleByScope: mapRunLifecycleRows(
      flattenBatchPages<RunLifecycleAggregateRow>(
        lifecycle.pages,
        lifecycleQueries.length,
        "run-lifecycle",
      ),
    ),
    lastChangeByFlag: mapLatestChangeRows(
      flattenBatchPages<LatestChangeRow>(changes.pages, changeQueries.length, "latest-change"),
    ),
    hasInWindowLegacyRuns: legacyRows.length > 0,
  };
}
