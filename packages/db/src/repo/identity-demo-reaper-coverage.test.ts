import { getTableConfig } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";
// biome-ignore lint/performance/noNamespaceImport: the check is "every table", so it needs the whole table namespace as one object rather than a hand-kept list that would drift exactly the way the reap did.
import * as schema from "../schema/index";
import { DEMO_REAP_DELETE_ORDER } from "./identity-demo-reaper";

type TableConfig = ReturnType<typeof getTableConfig>;

/**
 * The reap is pinned against the Drizzle schema rather than a hand-kept list. A
 * new App-scoped table is invisible to review: it either outlives the demo
 * Organization or fails its foreign key when the App goes, and either way it
 * only surfaces once a demo org has actually used the feature.
 */
describe("demo reap delete plan", () => {
  it("clears every table that hangs off an App", () => {
    const appScoped = tables()
      .filter((config) => config.columns.some((column) => column.name === "app_id"))
      .map((config) => config.name);
    expect(appScoped.length).toBeGreaterThan(0);
    expect(appScoped.filter((name) => !DEMO_REAP_DELETE_ORDER.includes(name))).toEqual([]);
  });

  it("clears every child before the table it references", () => {
    const edges = tables().flatMap(reapedEdges);
    expect(edges.length).toBeGreaterThan(0);
    for (const [child, parent] of edges) {
      expect(
        DEMO_REAP_DELETE_ORDER.indexOf(child),
        `${child} is reaped after ${parent}, so its foreign key fails`,
      ).toBeLessThan(DEMO_REAP_DELETE_ORDER.indexOf(parent));
    }
  });
});

/** Every foreign key whose child and parent are both reaped, as [child, parent]. */
function reapedEdges(config: TableConfig): [string, string][] {
  if (!DEMO_REAP_DELETE_ORDER.includes(config.name)) return [];
  const parents = config.foreignKeys.map(
    (key) => getTableConfig(key.reference().foreignTable).name,
  );
  return [...new Set(parents)]
    .filter((parent) => parent !== config.name && DEMO_REAP_DELETE_ORDER.includes(parent))
    .map((parent) => [config.name, parent]);
}

function tables(): TableConfig[] {
  return Object.values(schema).flatMap((table) => {
    try {
      return [getTableConfig(table as never)];
    } catch {
      return [];
    }
  });
}
