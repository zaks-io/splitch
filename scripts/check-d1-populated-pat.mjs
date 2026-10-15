import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

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

    const reapplied = JSON.parse(
      run.execSql(
        `${readFileSync(new URL(`../packages/db/migrations/${MIGRATION}`, import.meta.url), "utf8")}\nSELECT changes() AS changed;`,
        "re-applying the PAT permissions migration",
        true,
      ),
    );
    assert.equal(reapplied.at(-1).results[0].changed, 0, "re-applying must not rewrite any row");
    assert.deepEqual(rows(), migrated, "re-applying must leave every PAT column unchanged");
    console.log(
      "✔ d1:migrate:populated: legacy PAT grants preserve authority and re-apply changes no rows.",
    );
  } finally {
    run.dispose();
  }
}
