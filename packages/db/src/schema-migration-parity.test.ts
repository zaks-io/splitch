import { getTableConfig } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";
import { createLocalD1 } from "./repo/test-d1-pool";
// biome-ignore lint/performance/noNamespaceImport: the check is "every table", so it needs the whole table namespace as one object rather than a hand-kept list that would drift the same way the indexes did.
import * as schema from "./schema/index";

/**
 * The migration set is hand-authored, so the Drizzle table definitions are a
 * second copy of the same truth rather than the thing that generates them.
 * Nothing else compares the two.
 */
describe("Drizzle schema against the applied migrations", () => {
  /**
   * An index that lands in a migration but never reaches the schema file
   * survives every other test, and the next author to read the schema sees a
   * constraint that is not there.
   */
  it("declares in the Drizzle schema every index the migrations actually create", async () => {
    const local = await createLocalD1();
    try {
      const drift: Record<string, { declaredOnly: string[]; appliedOnly: string[] }> = {};
      for (const table of Object.values(schema)) {
        let config: ReturnType<typeof getTableConfig>;
        try {
          config = getTableConfig(table as never);
        } catch {
          continue;
        }
        // Partial-ness travels with the name: an index declared without its
        // WHERE clause silently widens a scoped constraint into a global one.
        const declared = new Set([
          ...config.indexes.map(
            (entry) => `${entry.config.name}${entry.config.where ? " (partial)" : ""}`,
          ),
          ...config.uniqueConstraints.map((entry) => requiredName(config.name, entry.name)),
        ]);
        const applied = new Set(
          (
            await local.d1
              .prepare(`PRAGMA index_list('${config.name}')`)
              .all<{ name: string; origin: string; partial: number }>()
          ).results
            // origin "c" is CREATE INDEX; "u"/"pk" are inline column constraints
            // that Drizzle expresses on the column, not in the index list.
            .filter((row) => row.origin === "c")
            .map((row) => `${row.name}${row.partial === 1 ? " (partial)" : ""}`),
        );
        const declaredOnly = [...declared].filter((name) => !applied.has(name)).sort();
        const appliedOnly = [...applied].filter((name) => !declared.has(name)).sort();
        if (declaredOnly.length > 0 || appliedOnly.length > 0) {
          drift[config.name] = { declaredOnly, appliedOnly };
        }
      }
      expect(drift).toEqual({});
    } finally {
      await local.dispose();
    }
  });
});

/**
 * Drizzle types a constraint name as optional, but an unnamed constraint has
 * nothing to compare against `PRAGMA index_list`. Dropping it would make this
 * guard quietly weaker on exactly the table that needed it.
 */
function requiredName(table: string, name: string | undefined): string {
  if (!name) throw new Error(`${table}: unique constraint has no name to compare`);
  return name;
}
