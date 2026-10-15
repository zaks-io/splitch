import { PersonalAccessTokenGrantsSchema, personalAccessTokenAuthority } from "@splitch/contracts";
import {
  applySchema,
  migrationFileStatements,
  migrationStatementsThrough,
} from "@splitch/db/test-migrations";
import { Miniflare } from "miniflare";
import { expect, it } from "vitest";

const MIGRATION = "0042_personal_access_token_permissions.sql";
const ALL_PERMISSIONS = ["write", "delete", "credentials", "members", "privacy"];

it("migrates both legacy grant shapes to schema-valid permissions without changing authority", async () => {
  const mf = new Miniflare({
    modules: true,
    script: "export default {};",
    d1Databases: { DB: ":memory:" },
  });
  try {
    const d1 = (await mf.getD1Database("DB")) as unknown as D1Database;
    await applySchema(d1, migrationStatementsThrough("0041_delivery_retention.sql"));
    const existing = '[ { "target": "all", "role": "owner", "permissions": ["privacy"] } ]';
    const seeds = [
      [
        "pat_legacy_read",
        JSON.stringify([{ target: "app:app_read", role: "member", access: "read" }]),
      ],
      [
        "pat_legacy_write",
        JSON.stringify([
          { target: "org:org_write", role: "admin", access: "read-write" },
          { target: "all", role: "owner", access: "read" },
          { target: "app:app_new", role: "admin", permissions: ["credentials"] },
        ]),
      ],
      ["pat_existing", existing],
    ];
    await d1.batch(
      seeds.map(([id, grants]) =>
        d1
          .prepare(
            "INSERT INTO personal_access_tokens (id, user_id, name, token_hash, grants, created_at) VALUES (?, 'user_migration', 'Migration probe', ?, ?, '2026-10-15T00:00:00.000Z')",
          )
          .bind(id, id, grants),
      ),
    );

    await applySchema(d1, migrationFileStatements(MIGRATION));
    const migrated = await d1
      .prepare("SELECT * FROM personal_access_tokens ORDER BY id")
      .all<{ id: string; grants: string }>();
    const byId = Object.fromEntries(migrated.results.map((row) => [row.id, row.grants]));
    expect(PersonalAccessTokenGrantsSchema.parse(JSON.parse(byId.pat_legacy_read))).toEqual([
      { target: "app:app_read", role: "member", permissions: [] },
    ]);
    expect(PersonalAccessTokenGrantsSchema.parse(JSON.parse(byId.pat_legacy_write))).toEqual([
      { target: "org:org_write", role: "admin", permissions: ALL_PERMISSIONS },
      { target: "all", role: "owner", permissions: [] },
      { target: "app:app_new", role: "admin", permissions: ["credentials"] },
    ]);
    for (const row of migrated.results) {
      expect(PersonalAccessTokenGrantsSchema.safeParse(JSON.parse(row.grants)).success).toBe(true);
    }
    const memberships = {
      organizations: [
        { id: "org_write", role: "owner" as const },
        { id: "org_other", role: "member" as const },
      ],
      apps: [
        { id: "app_read", organizationId: "org_other", role: "owner" as const },
        { id: "app_write", organizationId: "org_write", role: "owner" as const },
        { id: "app_new", organizationId: "org_other", role: "owner" as const },
      ],
    };
    const readAuthority = personalAccessTokenAuthority(
      memberships,
      PersonalAccessTokenGrantsSchema.parse(JSON.parse(byId.pat_legacy_read)),
    );
    expect(readAuthority.scopes).toEqual(["app:app_read:member"]);
    for (const permission of Object.values(readAuthority.permissions)) {
      expect(permission).toEqual({ scopes: [], all: false });
    }
    const writeAuthority = personalAccessTokenAuthority(
      memberships,
      PersonalAccessTokenGrantsSchema.parse(JSON.parse(byId.pat_legacy_write)),
    );
    expect(writeAuthority.scopes).toEqual([
      "app:app_new:owner",
      "app:app_read:owner",
      "app:app_write:owner",
      "org:org_other:member",
      "org:org_write:owner",
    ]);
    for (const [permission, authority] of Object.entries(writeAuthority.permissions)) {
      expect(authority).toEqual({
        scopes:
          permission === "credentials"
            ? ["app:app_new:admin", "app:app_write:admin", "org:org_write:admin"]
            : ["app:app_write:admin", "org:org_write:admin"],
        all: false,
      });
    }
    expect(byId.pat_existing).toBe(existing);

    const reapplied = await d1.batch(
      migrationFileStatements(MIGRATION).map((sql) => d1.prepare(sql)),
    );
    expect(reapplied.map((result) => result.meta.changes)).toEqual([0]);
    expect(
      (await d1.prepare("SELECT * FROM personal_access_tokens ORDER BY id").all()).results,
    ).toEqual(migrated.results);
  } finally {
    await mf.dispose();
  }
});
