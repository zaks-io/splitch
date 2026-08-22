import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRepository } from "../index";
import { appScope } from "./scope";
import { createLocalD1, type LocalD1 } from "./test-d1-pool";

/**
 * Environments list in creation order, not key order. The sidebar pills, the
 * segmented control, the App home matrix columns, and the promotion source/target
 * pair all render straight from this read, so an undefined order here would show
 * `prod` before `dev` whenever the keys happen to sort that way.
 */

let local: LocalD1;
let repo: ReturnType<typeof createRepository>;

beforeEach(async () => {
  local = await createLocalD1();
  repo = createRepository(local.d1);
});

afterEach(async () => {
  await local.dispose();
});

describe("listEnvironments order", () => {
  it("returns Environments oldest first, key as the tiebreak", async () => {
    const statements = [
      `INSERT INTO organizations (id, name, slug, plan, is_provisional, created_at, updated_at) VALUES
         ('org_1', 'Org One', 'org-one', 'free', 0, '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')`,
      `INSERT INTO apps (id, organization_id, name, key, created_at, updated_at, created_by) VALUES
         ('app_1', 'org_1', 'App One', 'app-one', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z', 'user_1')`,
      `INSERT INTO environments (id, app_id, key, name, created_at, updated_at, created_by) VALUES
         ('env_b', 'app_1', 'zeta', 'Zeta', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z', 'user_1'),
         ('env_c', 'app_1', 'alpha', 'Alpha', '2026-08-03T00:00:00.000Z', '2026-08-03T00:00:00.000Z', 'user_1'),
         ('env_a', 'app_1', 'mid', 'Mid', '2026-08-02T00:00:00.000Z', '2026-08-02T00:00:00.000Z', 'user_1'),
         ('env_d', 'app_1', 'aardvark', 'Aardvark', '2026-08-02T00:00:00.000Z', '2026-08-02T00:00:00.000Z', 'user_1'),
         ('env_e', 'app_1', 'zzz-late', 'Late', '2026-08-02T00:00:00.000Z', '2026-08-02T00:00:00.000Z', 'user_1')`,
    ];
    for (const statement of statements) {
      await local.d1.prepare(statement).run();
    }

    const rows = await repo.identity.listEnvironments(appScope("app_1"));

    expect(rows.map((row) => row.key)).toEqual(["zeta", "aardvark", "mid", "zzz-late", "alpha"]);
  });
});
