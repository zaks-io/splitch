import { and, asc, desc, eq, gt, isNull, lt, lte, gte, or, type SQL } from "drizzle-orm";
import { flagChangeEvents } from "../schema/flag-change-events";
import type { Db } from "./client";
import { assertMintedScope, type TenantScope, withTenantScope } from "./scope";

/**
 * Tenant-scoped reads over flag_change_events.
 *
 * environment_id is nullable (App-level definition changes), so this cannot go
 * through scopedTable: that factory would demand an EnvScope and drop every
 * definition row. app_id still comes from a minted TenantScope.
 */

export interface FlagChangeLogRow {
  seq: number;
  appId: string;
  environmentId: string | null;
  flagId: string;
  flagKey: string;
  action: "created" | "updated" | "deleted";
  targetType: string;
  actorRef: string | null;
  actorVia: string | null;
  changedAt: string;
  diffJson: string | null;
}

export interface FlagChangeLogFilter {
  from?: string;
  to?: string;
  flagId?: string;
  environmentIds?: readonly string[];
  includeAppLevel: boolean;
  afterSeq?: number;
  beforeSeq?: number;
  order: "asc" | "desc";
  limit: number;
}

const SCOPE_COLUMNS = {
  appId: flagChangeEvents.appId,
  appIdKey: "appId",
};

export function makeFlagChangeLogReads(db: Db) {
  return {
    async listForApp(scope: TenantScope, filter: FlagChangeLogFilter): Promise<FlagChangeLogRow[]> {
      assertMintedScope(scope);
      if (!Number.isInteger(filter.limit) || filter.limit < 1) {
        throw new Error(`flagChangeEvents.listForApp: limit must be a positive integer`);
      }
      const extra = extraPredicate(filter);
      const rows = await db
        .select()
        .from(flagChangeEvents)
        .where(withTenantScope(SCOPE_COLUMNS, scope, extra))
        .orderBy(filter.order === "asc" ? asc(flagChangeEvents.seq) : desc(flagChangeEvents.seq))
        .limit(filter.limit);
      return rows.map((row) => ({
        ...row,
        action: asAction(row.action),
      }));
    },
  };
}

function asAction(value: string): FlagChangeLogRow["action"] {
  if (value === "created" || value === "updated" || value === "deleted") return value;
  throw new Error(`flagChangeEvents.listForApp: unknown action "${value}"`);
}

function extraPredicate(filter: FlagChangeLogFilter): SQL {
  const parts: SQL[] = [];
  if (filter.from !== undefined) parts.push(gte(flagChangeEvents.changedAt, filter.from));
  if (filter.to !== undefined) parts.push(lte(flagChangeEvents.changedAt, filter.to));
  if (filter.flagId !== undefined) parts.push(eq(flagChangeEvents.flagId, filter.flagId));
  if (filter.afterSeq !== undefined) parts.push(gt(flagChangeEvents.seq, filter.afterSeq));
  if (filter.beforeSeq !== undefined) parts.push(lt(flagChangeEvents.seq, filter.beforeSeq));
  const environment = environmentPredicate(filter);
  if (environment) parts.push(environment);
  if (parts.length === 0) {
    // withTenantScope requires an extra predicate; a tautology keeps App-only
    // scans honest when the caller asked for the whole log.
    return gte(flagChangeEvents.seq, 0);
  }
  return and(...parts) as SQL;
}

function environmentPredicate(filter: FlagChangeLogFilter): SQL | undefined {
  const ids = filter.environmentIds ?? [];
  if (ids.length === 0 && filter.includeAppLevel) return undefined;
  const named = ids.map((id) => eq(flagChangeEvents.environmentId, id));
  if (filter.includeAppLevel) {
    return or(isNull(flagChangeEvents.environmentId), ...named) as SQL;
  }
  if (named.length === 0) return isNull(flagChangeEvents.environmentId);
  return or(...named) as SQL;
}
