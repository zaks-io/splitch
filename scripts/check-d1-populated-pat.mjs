import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const MIGRATION = "0042_personal_access_token_permissions.sql";
const ALL_PERMISSIONS = ["write", "delete", "credentials", "members", "privacy"];
const existing = '[ { "target": "all", "role": "owner", "permissions": ["privacy"] } ]';
const fixtures = [
  ["pat_legacy_read", [{ target: "app:app_read", role: "member", access: "read" }]],
  [
    "pat_legacy_write",
    [
      { target: "org:org_write", role: "admin", access: "read-write" },
      { target: "all", role: "owner", access: "read" },
      { target: "app:app_new", role: "admin", permissions: ["credentials"] },
    ],
  ],
  ["pat_existing", existing],
];

/** Seed immediately before the PAT migration so real Wrangler must rewrite stored grants. */
export function checkPersonalAccessTokenMigration(migrate) {
  const seed = fixtures.map(([id, grants]) => {
    const json = typeof grants === "string" ? grants : JSON.stringify(grants);
    return `INSERT INTO personal_access_tokens (id, user_id, name, token_hash, grants, created_at)
      VALUES ('${id}', 'user_pat_probe', 'Migration probe', '${id}', '${json}', '2026-10-15T00:00:00.000Z')`;
  });
  const run = migrate(seed, MIGRATION);
  try {
    assert.equal(run.apply.status, 0, run.apply.stderr || run.apply.stdout);
    const rows = () =>
      JSON.parse(
        run.execSql(
          "SELECT * FROM personal_access_tokens ORDER BY id",
          "verifying migrated PAT grants",
          true,
        ),
      ).flatMap((result) => result.results);
    const migrated = rows();
    const byId = Object.fromEntries(migrated.map((row) => [row.id, row.grants]));
    assert.deepEqual(JSON.parse(byId.pat_legacy_read), [
      { target: "app:app_read", role: "member", permissions: [] },
    ]);
    assert.deepEqual(JSON.parse(byId.pat_legacy_write), [
      { target: "org:org_write", role: "admin", permissions: ALL_PERMISSIONS },
      { target: "all", role: "owner", permissions: [] },
      { target: "app:app_new", role: "admin", permissions: ["credentials"] },
    ]);
    assert.equal(byId.pat_existing, existing, "new-shape rows must stay byte-for-byte unchanged");

    const rewrite = () => {
      const result = run.execFile(
        fileURLToPath(new URL(`../packages/db/migrations/${MIGRATION}`, import.meta.url)),
      );
      assert.equal(result.status, 0, result.stderr || result.stdout);
    };
    rewrite();
    assert.deepEqual(rows(), migrated, "re-applying must leave every PAT column unchanged");

    // The previous Worker can create and update legacy grants after the first rewrite.
    run.execSql(seed[0].replaceAll("pat_legacy_read", "pat_late_create"), "late legacy create");
    run.execSql(
      `UPDATE personal_access_tokens SET grants = '[{"target":"app:app_read","role":"member","access":"read"}]' WHERE id = 'pat_legacy_read'`,
      "late legacy update",
    );
    const legacyCount = () =>
      JSON.parse(
        run.execSql(
          "SELECT COUNT(*) AS legacy_grants FROM personal_access_tokens AS token, json_each(token.grants) AS grant WHERE json_type(grant.value, '$.access') IS NOT NULL",
          "post-cutover legacy grant count",
          true,
        ),
      )[0].results[0].legacy_grants;
    assert.equal(legacyCount(), 2);
    rewrite();
    assert.equal(legacyCount(), 0, "the standalone file must rewrite post-migration legacy rows");
    for (const row of rows().filter((row) =>
      ["pat_legacy_read", "pat_late_create"].includes(row.id),
    ))
      assert.deepEqual(JSON.parse(row.grants), [
        { target: "app:app_read", role: "member", permissions: [] },
      ]);
    const afterCutover = rows();
    rewrite();
    assert.deepEqual(
      rows(),
      afterCutover,
      "standalone reapplication must leave every row unchanged",
    );
    console.log(
      "✔ d1:migrate:populated: PAT authority preserved; standalone rewrite clears late legacy grants and re-apply changes no rows.",
    );
  } finally {
    run.dispose();
  }
}
