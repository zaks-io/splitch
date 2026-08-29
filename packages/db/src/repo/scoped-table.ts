import type { SQL } from "drizzle-orm";
import { count, getTableColumns, getTableName, sql } from "drizzle-orm";
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import type { Db } from "./client";
import type { EnvScope, ScopeColumns, TenantScope } from "./scope";
import { assertMintedScope, withScope } from "./scope";
import { crossEnvironmentPredicate, validatedReadLimit } from "./scoped-table-read";

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
  /**
   * ORDER BY terms, applied before `limit`.
   *
   * A `limit` with no order is only safe when the caller throws the rows away —
   * "is this scope past a budget" reads one row past the ceiling and then
   * refuses whole, so which rows came back never mattered. Any caller that KEEPS
   * a bounded page must pass a TOTAL order (end on a unique column), or two
   * otherwise identical reads can drop different rows and the page silently
   * shuffles between them.
   */
  orderBy?: readonly SQL[];
}

type Row<T extends SQLiteTable> = T["$inferSelect"];
type Insert<T extends SQLiteTable> = T["$inferInsert"];

type CrossEnvironmentRead<T extends AppScopedTable> = T extends HasEnvColumn
  ? {
      /**
       * Read an explicit Environment set under one App tenant boundary.
       *
       * This is the sanctioned ADR-0027 cross-Environment read. A foreign
       * Environment id cannot match because app_id remains mandatory.
       */
      findManyAcrossEnvironments(
        scope: TenantScope,
        environmentIds: readonly string[],
        extra?: SQL,
        options?: ReadOptions,
      ): Promise<Row<T>[]>;
    }
  : Record<never, never>;

type ScopedTableCore<T extends AppScopedTable> = {
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
   * The in-scope `id`s as a SUBQUERY instead of a resolved read, for the child
   * tables that carry no `app_id` of their own and are reached transitively
   * (`variants` -> `flags.id`). Proving those ids with a separate `findMany`
   * costs a D1 round trip whose only output is the id list the child statement
   * is about to filter on; nesting it spends one round trip instead of two.
   *
   * This does NOT relax the boundary: the predicate is still the mandatory one
   * `scope.ts` emits, on the same scope columns, just in the same statement as
   * the read it authorizes. Callers still cannot write their own `app_id`
   * filter, which is the property ADR-0018 rests on.
   *
   * Returns INERT `SQL`, never the query builder that produced it. A builder
   * would hand the caller a live `.where()` that replaces the scope predicate
   * rather than narrowing it, and it is awaitable, so the facade would be
   * handing out exactly the unscoped read this file exists to make
   * unconstructible.
   */
  idsInScope(scope: RequiredScope<T>, extra?: SQL): SQL;
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

export type ScopedTable<T extends AppScopedTable> = ScopedTableCore<T> & CrossEnvironmentRead<T>;

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

  const facade: ScopedTableCore<T> & {
    findManyAcrossEnvironments(
      scope: TenantScope,
      environmentIds: readonly string[],
      extra?: SQL,
      options?: ReadOptions,
    ): Promise<Row<T>[]>;
  } = {
    async findMany(scope, extra, options) {
      const filtered = db
        .select()
        .from(table as SQLiteTable)
        .where(withScope(columns, scope, extra));
      const query =
        options?.orderBy && options.orderBy.length > 0
          ? filtered.orderBy(...options.orderBy)
          : filtered;
      const limit = validatedReadLimit(options, "findMany");
      return limit === undefined
        ? (query as Promise<Row<T>[]>)
        : (query.limit(limit) as Promise<Row<T>[]>);
    },

    async findManyAcrossEnvironments(
      scope: TenantScope,
      environmentIds: readonly string[],
      extra?: SQL,
      options?: ReadOptions,
    ) {
      const predicate = crossEnvironmentPredicate(columns, scope, environmentIds, extra);
      if (!predicate) return [];
      const filtered = db
        .select()
        .from(table as SQLiteTable)
        .where(predicate);
      const query =
        options?.orderBy && options.orderBy.length > 0
          ? filtered.orderBy(...options.orderBy)
          : filtered;
      const limit = validatedReadLimit(options, "findManyAcrossEnvironments");
      return limit === undefined
        ? (query as Promise<Row<T>[]>)
        : (query.limit(limit) as Promise<Row<T>[]>);
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

    idsInScope(scope, extra) {
      const idColumn = (table as unknown as { id?: SQLiteColumn }).id;
      if (!idColumn) {
        throw new Error(
          `scopedTable.idsInScope: ${getTableName(table)} has no id column to prove ids against`,
        );
      }
      // `.getSQL()` freezes the statement: what leaves this method is a bare
      // fragment with no builder methods and no `then`, so the scope predicate
      // cannot be replaced or the subquery run on its own.
      return sql`(${db
        .select({ id: idColumn })
        .from(table as SQLiteTable)
        .where(withScope(columns, scope, extra))
        .getSQL()})`;
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
  return facade as unknown as ScopedTable<T>;
}
