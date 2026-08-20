import { Miniflare } from "miniflare";
import { afterEach, describe, expect, it } from "vitest";
import { createRepository } from "./index";
import { applySchema, migrationFileStatements, migrationStatementsThrough } from "./repo/test-d1";

let mf: Miniflare | undefined;

afterEach(async () => {
  await mf?.dispose();
  mf = undefined;
});

describe("App deletion generation migration", () => {
  it("backfills stable generation IDs for active and completed legacy sagas", async () => {
    mf = new Miniflare({
      modules: true,
      script: "export default {};",
      d1Databases: { DB: ":memory:" },
    });
    const d1 = (await mf.getD1Database("DB")) as unknown as D1Database;
    await applySchema(d1, migrationStatementsThrough("0021_app_deletion_saga_retention.sql"));
    await d1.batch([
      legacySagaInsert(d1, "app-legacy-active", "started", "2026-08-19T12:00:00.000Z"),
      legacySagaInsert(d1, "app-legacy-complete", "complete", "2026-08-19T13:00:00.000Z"),
    ]);

    await applySchema(d1, migrationFileStatements("0022_app_deletion_generation.sql"));

    const repo = createRepository(d1);
    await expect(repo.identity.getAppDeletionSaga("app-legacy-active")).resolves.toMatchObject({
      generationId: "legacy:app-legacy-active:2026-08-19T12:00:00.000Z",
      phase: "started",
    });
    await expect(repo.identity.getAppDeletionSaga("app-legacy-complete")).resolves.toMatchObject({
      generationId: "legacy:app-legacy-complete:2026-08-19T13:00:00.000Z",
      phase: "complete",
    });
  });
});

function legacySagaInsert(
  d1: D1Database,
  appId: string,
  phase: "started" | "complete",
  createdAt: string,
): D1PreparedStatement {
  const active = phase === "started";
  return d1
    .prepare(
      `INSERT INTO app_deletion_sagas (
         app_id, organization_id, actor_id, delete_before_ts, retry_actor_hash,
         organization_scope_hash, phase, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      appId,
      active ? "org-legacy" : null,
      active ? "user-legacy" : null,
      active ? createdAt : null,
      "retry-hash",
      "organization-hash",
      phase,
      createdAt,
      createdAt,
    );
}
