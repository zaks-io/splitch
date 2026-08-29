import type { SQL } from "drizzle-orm";
import { and, inArray } from "drizzle-orm";
import type { ScopeColumns, TenantScope } from "./scope";
import { withTenantScope } from "./scope";
import type { ReadOptions } from "./scoped-table";

export function crossEnvironmentPredicate(
  columns: ScopeColumns,
  scope: TenantScope,
  environmentIds: readonly string[],
  extra?: SQL,
): SQL | null {
  if (!columns.environmentId) {
    throw new Error("findManyAcrossEnvironments: table has no environmentId column");
  }
  if (environmentIds.length === 0) return null;
  const environmentPredicate = inArray(columns.environmentId, [...environmentIds]);
  return withTenantScope(
    columns,
    scope,
    extra ? (and(environmentPredicate, extra) as SQL) : environmentPredicate,
  );
}

export function validatedReadLimit(
  options: ReadOptions | undefined,
  method: string,
): number | undefined {
  const limit = options?.limit;
  if (limit === undefined) return undefined;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`${method}: limit must be a positive integer, got ${limit}`);
  }
  return limit;
}
