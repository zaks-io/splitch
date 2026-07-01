import { drizzle } from "drizzle-orm/d1";
// biome-ignore lint/performance/noNamespaceImport: drizzle(d1, { schema }) takes the whole table namespace as one object; this is drizzle's documented schema-registration shape, not an unused-tree-shaking concern.
import * as schema from "../schema/index.js";

/**
 * The raw Drizzle client, ENCAPSULATED.
 *
 * WHY this is internal-only: this module is the one place `drizzle(d1)` is
 * constructed, and the `Db` type / the client itself are never re-exported from
 * the package root (see ../index.ts). Everything outside `repo/` gets the
 * `Repository` facade, whose methods are all scope-bound. A caller therefore
 * has no handle on which to run an arbitrary, app_id-less query — the bypass is
 * removed structurally, not by convention (ADR-0018). The depcruise / Semgrep
 * rules then catch anyone who tries to re-import `drizzle-orm/d1` to rebuild one.
 */

export type Db = ReturnType<typeof drizzle<typeof schema>>;

/** Bind the raw Drizzle client to a D1 binding. Internal to the seam. */
export function createDb(d1: D1Database): Db {
  return drizzle(d1, { schema });
}
