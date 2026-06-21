import { existsSync } from "node:fs";

const migrationDirs = ["drizzle", "migrations", "apps/control-plane-api/migrations"];
const hasMigrations = migrationDirs.some((path) => existsSync(path));

if (!hasMigrations) {
  console.log("d1:migrate:local: skipped. No local D1 migrations exist yet.");
  process.exit(0);
}

console.log("d1:migrate:local: migrations found; wire wrangler D1 apply in the schema slice.");
