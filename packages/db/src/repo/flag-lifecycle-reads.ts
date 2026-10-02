import { and, asc, isNotNull, lte } from "drizzle-orm";
import { flags } from "../schema/index";
import type { TenantScope } from "./scope";
import type { scopedTable } from "./scoped-table";

/**
 * One bounded page of the App's expired-but-live Flags: `expires_at` at or
 * before `now`, most overdue first. A Flag that still has a row is still
 * evaluable, so existence is what "live" means here; deletion removes it.
 *
 * Filtered in SQL on the partial `flags_app_expires_at_idx` rather than over
 * a catalog page, because a filter applied after a LIMIT would silently drop
 * expired Flags that fell outside the page. `id` breaks ties for a total order.
 */
export function makeListExpiredFlagPage(table: ReturnType<typeof scopedTable<typeof flags>>) {
  return (scope: TenantScope, now: string, limit: number) =>
    table.findMany(scope, and(isNotNull(flags.expiresAt), lte(flags.expiresAt, now)), {
      limit,
      orderBy: [asc(flags.expiresAt), asc(flags.id)],
    });
}

export type FlagDefinitionPatch = Partial<
  Pick<
    typeof flags.$inferInsert,
    | "name"
    | "description"
    | "schema"
    | "defaultVariantId"
    | "lifecycleClass"
    | "owner"
    | "expiresAt"
    | "updatedAt"
    | "updatedBy"
  >
>;
