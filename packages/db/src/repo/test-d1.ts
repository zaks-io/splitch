import { Miniflare } from "miniflare";
import {
  applySchema,
  migrationFileStatements,
  migrationStatements,
  migrationStatementsThrough,
} from "../test-migrations";

export { applySchema, migrationFileStatements, migrationStatements, migrationStatementsThrough };

export type LocalD1 = {
  d1: D1Database;
  dispose: () => Promise<void>;
};

/** Spin up a fresh in-memory local D1 with the full migration set applied. */
export async function createLocalD1(): Promise<LocalD1> {
  const mf = new Miniflare({
    modules: true,
    script: "export default {};",
    d1Databases: { DB: ":memory:" },
  });
  const d1 = (await mf.getD1Database("DB")) as unknown as D1Database;

  await applySchema(d1, migrationStatements());

  return {
    d1,
    dispose: () => mf.dispose(),
  };
}
