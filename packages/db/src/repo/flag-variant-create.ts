import { asc, eq, type SQL, sql } from "drizzle-orm";
import { type flags, variants } from "../schema/index";
import type { Db } from "./client";
import type { TenantScope } from "./scope";

export type FlagInScope = (
  scope: TenantScope,
  flagId: string,
) => Promise<typeof flags.$inferSelect | null>;

type VariantByName = (
  scope: TenantScope,
  flagId: string,
  name: string,
) => Promise<typeof variants.$inferSelect | null>;

export function variantsInInsertOrder(db: Db, predicate: SQL<unknown>) {
  return db
    .select()
    .from(variants)
    .where(predicate)
    .orderBy(asc(sql`${variants}.rowid`));
}

export function makeEnsureCreateVariant(
  db: Db,
  flagInScope: FlagInScope,
  variantByName: VariantByName,
) {
  return async function ensureCreateVariant(
    scope: TenantScope,
    flagId: string,
    values: Omit<typeof variants.$inferInsert, "flagId">,
  ): Promise<typeof variants.$inferSelect> {
    const flag = await flagInScope(scope, flagId);
    if (!flag) throw new Error("ensureCreateVariant: flag is not in this App scope");
    const existing = await variantByName(scope, flagId, values.name);
    if (existing) return existing;
    return insertCreateVariantOrWinner(db, variantByName, scope, flagId, values);
  };
}

async function insertCreateVariantOrWinner(
  db: Db,
  variantByName: VariantByName,
  scope: TenantScope,
  flagId: string,
  values: Omit<typeof variants.$inferInsert, "flagId">,
): Promise<typeof variants.$inferSelect> {
  try {
    const rows = await db
      .insert(variants)
      .values({ ...values, flagId })
      .returning();
    const inserted = rows[0];
    if (!inserted) throw new Error("ensureCreateVariant: no row returned");
    return inserted;
  } catch (cause) {
    const winner = await variantByName(scope, flagId, values.name);
    if (winner) return winner;
    throw cause;
  }
}

export function makeEnsureCreateVariants(db: Db, flagInScope: FlagInScope) {
  return async function ensureCreateVariants(
    scope: TenantScope,
    flagId: string,
    values: readonly Omit<typeof variants.$inferInsert, "flagId">[],
  ): Promise<(typeof variants.$inferSelect)[]> {
    const flag = await flagInScope(scope, flagId);
    if (!flag) throw new Error("ensureCreateVariants: flag is not in this App scope");
    if (values.length === 0) return [];

    const current = await variantsInInsertOrder(db, eq(variants.flagId, flagId));
    const currentNames = new Set(current.map((variant) => variant.name));
    const missing = values.filter((variant) => !currentNames.has(variant.name));
    if (missing.length > 0) {
      const statements = batchesOf(missing, 15).map((batch) =>
        db
          .insert(variants)
          .values(batch.map((variant) => ({ ...variant, flagId })))
          .onConflictDoNothing(),
      );
      await db.batch(statements as unknown as Parameters<Db["batch"]>[0]);
    }

    const settled = await variantsInInsertOrder(db, eq(variants.flagId, flagId));
    const byName = new Map(settled.map((variant) => [variant.name, variant]));
    return values.map((variant) => {
      const row = byName.get(variant.name);
      if (!row) throw new Error(`ensureCreateVariants: Variant ${variant.name} was not created`);
      return row;
    });
  };
}

function batchesOf<T>(values: readonly T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let start = 0; start < values.length; start += size) {
    batches.push(values.slice(start, start + size));
  }
  return batches;
}
