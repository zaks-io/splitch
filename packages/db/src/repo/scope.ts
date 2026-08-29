import type { SQL, SQLWrapper } from "drizzle-orm";
import { and, eq, inArray } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";

/**
 * Tenant scope value objects.
 *
 * WHY this exists: D1 has no row-level security, so `WHERE app_id = ?` in the
 * data-access seam IS the tenant isolation boundary (ADR-0018). A bare string
 * `appId` is too easy to forget, swap, or pass positionally. These branded
 * objects make the scope a *value you must construct on purpose* and the only
 * thing a scoped table will accept — a caller cannot fabricate one by writing a
 * string literal, and the constructors below are the single mint points.
 *
 * A `TenantScope` carries `appId`. An `EnvScope` additionally carries
 * `environmentId` for the per-Environment tables (experiments, runs,
 * flag_configs, targeting_rules, api_keys, client_keys — ADR-0027). `EnvScope`
 * is a subtype of `TenantScope`, so an App-scoped method also accepts an
 * Env-scope; the reverse is rejected by the type system.
 */

declare const tenantBrand: unique symbol;
declare const envBrand: unique symbol;
declare const multiAppBrand: unique symbol;

export type TenantScope = {
  readonly appId: string;
  readonly [tenantBrand]: true;
};

export type EnvScope = TenantScope & {
  readonly environmentId: string;
  readonly [envBrand]: true;
};

export type MultiAppScope = {
  readonly appIds: readonly string[];
  readonly [multiAppBrand]: true;
};

/**
 * Runtime authenticity registry. The brand above is compile-time only, so a
 * forged `{ appId } as never` plain object would type-check as a scope and
 * silently bind whatever appId it carries. Membership lives in a module-private
 * WeakSet, NOT as an own-property on the returned object, so a caller cannot lift
 * or copy it onto a forged scope; the prior on-object symbol was liftable via
 * `Object.getOwnPropertySymbols(realScope)` — any caller holding a legitimate
 * scope (every repo caller holds their own tenant's) could read that symbol off
 * and brand a forged scope for a victim tenant. A WeakSet keys by object
 * identity: a real scope passes and a forged plain object fails even if it copied
 * every visible property. `scopePredicate`/`scopeValues` assert membership — a
 * forged scope fails loud instead of silently scoping (fail-loud, ADR-0036).
 */
const MINTED = new WeakSet<object>();
const MINTED_MULTI_APP = new WeakSet<object>();

function brandScope<T extends object>(scope: T): T {
  MINTED.add(scope);
  // Freeze the scope so the data properties (appId / environmentId) are
  // immutable. TS `readonly` is compile-time only; a minted scope could
  // otherwise be rebound at runtime — `(s as any).appId = "other-tenant"` —
  // and, being the same registered object, stay minted while redirecting every
  // scoped read/write to another tenant. Frozen, that reassignment throws in
  // strict mode (ESM is always strict). Freezing is orthogonal to forgeability
  // (the WeakSet handles that); it independently blocks the mutation bug. The
  // scope is tamper-proof after minting.
  Object.freeze(scope);
  return scope;
}

export function assertMintedScope(scope: TenantScope): void {
  if (!MINTED.has(scope)) {
    throw new Error("scope: not minted by appScope/envScope — a forged scope is rejected");
  }
}

/** Mint an App-level scope. Fails loud on an empty/blank appId. */
export function appScope(appId: string): TenantScope {
  if (!appId) {
    throw new Error("appScope: appId is required and must be non-empty");
  }
  return brandScope({ appId }) as TenantScope;
}

/** Mint a per-Environment scope. Fails loud on an empty/blank id. */
export function envScope(appId: string, environmentId: string): EnvScope {
  if (!appId || !environmentId) {
    throw new Error("envScope: both appId and environmentId are required and non-empty");
  }
  return brandScope({ appId, environmentId }) as EnvScope;
}

/** Mint the explicit App set for an intentional cross-App read. */
export function multiAppScope(appIds: readonly string[]): MultiAppScope {
  if (appIds.some((appId) => !appId)) {
    throw new Error("multiAppScope: every appId is required and must be non-empty");
  }
  const scope = Object.freeze({ appIds: Object.freeze([...new Set(appIds)]) });
  MINTED_MULTI_APP.add(scope);
  return scope as MultiAppScope;
}

export function assertMintedMultiAppScope(scope: MultiAppScope): void {
  if (!MINTED_MULTI_APP.has(scope)) {
    throw new Error("scope: multi-App scope was not minted by multiAppScope");
  }
}

/**
 * The scope columns a scoped table must bind, carrying BOTH the Drizzle column
 * (for the WHERE predicate, which keys by column) AND the Drizzle PROPERTY name
 * (for the INSERT `.values()` stamp and the UPDATE `.set()` strip, which key by
 * property — NOT the SQL column name). Carrying the property key here is what
 * makes the tenant-stamp / move-strip actually operate on the right key; using
 * `column.name` (the SQL name) silently no-ops them (cross-tenant write breach).
 */
export type ScopeColumns = {
  readonly appId: SQLiteColumn;
  readonly appIdKey: string;
  readonly environmentId?: SQLiteColumn;
  readonly environmentIdKey?: string;
};

/**
 * Build the mandatory, non-conditional scope predicate for a table. This is the
 * single place the `app_id` (and, when present, `environment_id`) equality is
 * emitted. Every scoped query routes through here; there is no code path that
 * produces a tenant-table query without this predicate.
 */
function scopePredicate(columns: ScopeColumns, scope: TenantScope): SQL {
  assertMintedScope(scope);
  const parts: SQLWrapper[] = [eq(columns.appId, scope.appId)];
  if (columns.environmentId) {
    // The column demands environment_id; only an EnvScope reaches here (the
    // scoped-table factory rejects a bare TenantScope for env tables at compile
    // time). Read it off the scope, failing loud if it is somehow absent.
    const environmentId = (scope as EnvScope).environmentId;
    if (!environmentId) {
      throw new Error("scopePredicate: per-Environment table requires an EnvScope");
    }
    parts.push(eq(columns.environmentId, environmentId));
  }
  // `and` of a non-empty list is always defined; the cast documents that.
  return and(...parts) as SQL;
}

/** Combine the mandatory scope predicate with caller-supplied extra filters. */
export function withScope(columns: ScopeColumns, scope: TenantScope, extra?: SQL): SQL {
  const base = scopePredicate(columns, scope);
  return extra ? (and(base, extra) as SQL) : base;
}

/**
 * App-scoped predicate for an intentional cross-Environment read.
 *
 * The caller still supplies a minted TenantScope, so app_id remains the tenant
 * boundary. The scoped-table method that uses this requires an explicit,
 * non-empty Environment id set and adds that set as a separate predicate.
 */
export function withTenantScope(columns: ScopeColumns, scope: TenantScope, extra: SQL): SQL {
  assertMintedScope(scope);
  return and(eq(columns.appId, scope.appId), extra) as SQL;
}

/**
 * Mandatory predicate for a deliberate cross-App read.
 *
 * Empty sets fail before SQL construction. Repository callers return an empty
 * result for that case, so an empty principal can never degrade into an
 * unscoped statement.
 */
export function withMultiAppScope(
  appIdColumn: SQLiteColumn,
  scope: MultiAppScope,
  extra?: SQL,
): SQL {
  assertMintedMultiAppScope(scope);
  if (scope.appIds.length === 0) {
    throw new Error("withMultiAppScope: an empty App set cannot produce SQL");
  }
  const base = inArray(appIdColumn, [...scope.appIds]);
  return extra ? (and(base, extra) as SQL) : base;
}
