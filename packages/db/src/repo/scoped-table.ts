import type { SQL } from "drizzle-orm";
import { count, getTableColumns, getTableName } from "drizzle-orm";
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import type { Db } from "./client";
import type { EnvScope, ScopeColumns, TenantScope } from "./scope";
import { assertMintedScope, withScope } from "./scope";

/**
 * The structural tenant-scope guarantee (ADR-0018).
 *
 * WHY this file is the whole security argument: every tenant-scoped read and
 * write is built here, and EVERY builder ANDs in the mandatory scope predicate
 * (`scope.ts`). There is no method that runs a query without the scope, so
 * "forgot the app_id filter" is not a mistake a repository method can make — the
 * filter is injected by the factory, not copy-pasted per call site.
 *
 * Two more invariants this encodes:
 *  - A table whose schema has an `environment_id` column is wired as a
 *    per-Environment table and its facade demands an `EnvScope`. A table without
 *    that column takes a `TenantScope`. The mismatch is a compile error, so an
 *    Env table can never be queried with only an app_id.
 *  - The raw `Db` (drizzle client) is closed over here and never returned. The
 *    facade exposes only scope-bound operations.
 */

/** A table the seam treats as tenant-scoped: it must expose an `appId` column. */
type AppScopedTable = SQLiteTable & { appId: SQLiteColumn };

/** Narrow to the tables that additionally carry an `environmentId` column. */
type HasEnvColumn = { environmentId: SQLiteColumn };

/**
 * The scope a table requires, derived from its columns: an `EnvScope` when the
 * table has an `environmentId` column, a plain `TenantScope` otherwise. This is
 * the type-level enforcement of the per-Environment co-scope.
 */
type RequiredScope<T extends AppScopedTable> = T extends HasEnvColumn ? EnvScope : TenantScope;

export interface ReadOptions {
  limit?: number;
}

type Row<T extends SQLiteTable> = T["$inferSelect"];
type Insert<T extends SQLiteTable> = T["$inferInsert"];

export type ScopedTable<T extends AppScopedTable> = {
  /**
   * Rows in this scope matching the optional extra predicate. `limit` bounds the
   * rows materialized, for callers that only need to know whether a ceiling is
   * exceeded and must not pay for the whole table to find out.
   */
  findMany(scope: RequiredScope<T>, extra?: SQL, options?: ReadOptions): Promise<Row<T>[]>;
  /** How many rows are in this scope, without materializing any of them. */
  countRows(scope: RequiredScope<T>, extra?: SQL): Promise<number>;
  /** First row in this scope matching the extra predicate, or null. */
  findOne(scope: RequiredScope<T>, extra?: SQL): Promise<Row<T> | null>;
  /**
   * Insert a row, stamping the scope columns from `scope` so the persisted
   * `app_id` / `environment_id` always match the caller's scope — a row cannot
   * be written into another tenant even if the input object disagrees.
   */
  insert(scope: RequiredScope<T>, values: Insert<T>): Promise<Row<T>>;
  /** Update rows in this scope; the scope predicate bounds every UPDATE. */
  update(scope: RequiredScope<T>, values: Partial<Insert<T>>, extra?: SQL): Promise<Row<T>[]>;
  /** Delete rows in this scope; the scope predicate bounds every DELETE. */
  remove(scope: RequiredScope<T>, extra?: SQL): Promise<number>;
};

function scopeColumns(table: AppScopedTable): ScopeColumns {
  // getTableColumns keys by the Drizzle PROPERTY name (appId / environmentId),
  // NOT the snake_case SQL name. We need BOTH: the column object for the WHERE
  // predicate (keyed by column), and the property KEY for the INSERT .values()
  // stamp and UPDATE .set() strip (keyed by property). Reading the SQL name
  // (`column.name`) for the value paths silently no-ops the tenant stamp/strip —
  // a cross-tenant write breach. Fail loud if app_id is somehow absent.
  const columns = getTableColumns(table) as Record<string, SQLiteColumn>;
  const appId = columns.appId;
  if (!appId) {
    throw new Error(`scopedTable: table has no appId column; it is not tenant-scoped`);
  }
  const environmentId = columns.environmentId;
  return environmentId
    ? { appId, appIdKey: "appId", environmentId, environmentIdKey: "environmentId" }
    : { appId, appIdKey: "appId" };
}

/**
 * The scope-column values to stamp onto an INSERT, mirroring the WHERE columns
 * so a write lands in exactly the scope it was issued for.
 */
function scopeValues(columns: ScopeColumns, scope: TenantScope): Record<string, string> {
  // Gate the WRITE path on WeakSet membership, identically to scopePredicate on
  // the read path. scopeValues is the single chokepoint every INSERT stamp flows
  // through, so a forged scope (`{ appId } as never`, not in the mint registry)
  // that the type system can't catch fails loud HERE instead of stamping a
  // victim tenant's app_id onto the new row (cross-tenant write, ADR-0018/0036).
  assertMintedScope(scope);
  // Key by the Drizzle PROPERTY name (appIdKey / environmentIdKey), which is what
  // .values() reads — NOT column.name. Spread LAST at the call site so the
  // scope's value always wins over any forged appId/environmentId in the input.
  const values: Record<string, string> = { [columns.appIdKey]: scope.appId };
  if (columns.environmentIdKey) {
    values[columns.environmentIdKey] = (scope as EnvScope).environmentId;
  }
  return values;
}

/**
 * Wrap a Drizzle table as a tenant-scoped facade. The returned object is the
 * ONLY way the repository touches this table; the raw `db` and `table` are
 * captured in the closure and never escape.
 */
export function scopedTable<T extends AppScopedTable>(db: Db, table: T): ScopedTable<T> {
  const columns = scopeColumns(table);

  return {
    async findMany(scope, extra, options) {
      const query = db
        .select()
        .from(table as SQLiteTable)
        .where(withScope(columns, scope, extra));
      if (options?.limit === undefined) return query as Promise<Row<T>[]>;
      if (!Number.isInteger(options.limit) || options.limit < 1) {
        throw new Error(`findMany: limit must be a positive integer, got ${options.limit}`);
      }
      return query.limit(options.limit) as Promise<Row<T>[]>;
    },

    async countRows(scope, extra) {
      const rows = (await db
        .select({ total: count() })
        .from(table as SQLiteTable)
        .where(withScope(columns, scope, extra))) as { total: number }[];
      const total = rows[0]?.total;
      if (typeof total !== "number") throw new Error("countRows: COUNT returned no row");
      return total;
    },

    async findOne(scope, extra) {
      const rows = (await db
        .select()
        .from(table as SQLiteTable)
        .where(withScope(columns, scope, extra))
        .limit(1)) as Row<T>[];
      return rows[0] ?? null;
    },

    async insert(scope, values) {
      // scopeValues spread LAST so the scope's app_id/environment_id always win
      // over any forged value in the input — a write lands in the issuing scope,
      // never the caller's claimed one.
      const stamped = { ...values, ...scopeValues(columns, scope) } as Insert<T>;
      const rows = (await db.insert(table).values(stamped).returning()) as Row<T>[];
      const inserted = rows[0];
      if (!inserted) {
        throw new Error(`scopedTable.insert: no row returned for ${getTableName(table)}`);
      }
      return inserted;
    },

    async update(scope, values, extra) {
      // Scope columns are immutable post-insert: an UPDATE that sets app_id /
      // environment_id would move a row across tenants. A caller passing a scope
      // column in update values is ALWAYS a bug — fail loud (do not silently
      // drop it), keyed by the Drizzle PROPERTY name (.set() keys by property).
      const input = values as Record<string, unknown>;
      if (columns.appIdKey in input) {
        throw new Error(
          `scopedTable.update: cannot set scope column "${columns.appIdKey}" — rows are immutable across tenants`,
        );
      }
      if (columns.environmentIdKey && columns.environmentIdKey in input) {
        throw new Error(
          `scopedTable.update: cannot set scope column "${columns.environmentIdKey}" — rows are immutable across Environments`,
        );
      }
      return db
        .update(table)
        .set(values)
        .where(withScope(columns, scope, extra))
        .returning() as Promise<Row<T>[]>;
    },

    async remove(scope, extra) {
      const rows = (await db
        .delete(table)
        .where(withScope(columns, scope, extra))
        .returning()) as Row<T>[];
      return rows.length;
    },
  };
}
