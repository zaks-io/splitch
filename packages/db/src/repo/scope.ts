import type { SQL, SQLWrapper } from "drizzle-orm";
import { and, eq } from "drizzle-orm";
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

export type TenantScope = {
  readonly appId: string;
  readonly [tenantBrand]: true;
};

export type EnvScope = TenantScope & {
  readonly environmentId: string;
  readonly [envBrand]: true;
};

/**
 * Runtime authenticity marker. The brand above is compile-time only, so a
 * hand-forged `{ appId } as never` plain object would type-check as a scope and
 * silently bind whatever appId it carries. Every minted scope gets this
 * NON-ENUMERABLE marker (non-enumerable so it never leaks into a spread / an
 * INSERT values object), and `scopePredicate` asserts it — a forged scope fails
 * loud instead of silently scoping (fail-loud, ADR-0036).
 */
const SCOPE_MARKER = Symbol("splitch.scope");

function brandScope<T extends object>(scope: T): T {
  Object.defineProperty(scope, SCOPE_MARKER, {
    value: true,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return scope;
}

function assertMintedScope(scope: TenantScope): void {
  if (!(scope as Record<symbol, unknown>)[SCOPE_MARKER]) {
    throw new Error(
      "scope: value was not minted by appScope/envScope — a hand-forged scope is rejected",
    );
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
