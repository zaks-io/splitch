import type { flags } from "./schema/flags";

type FlagInsert = typeof flags.$inferInsert;
type FlagSeed = Pick<FlagInsert, "id" | "appId" | "key" | "name" | "createdAt" | "updatedAt"> &
  Partial<FlagInsert>;

/** Keep new required database fields in one place without inventing fixture identities. */
export function flagRow(values: FlagSeed): FlagInsert {
  return { lifecycleClass: "ops", ...values };
}
