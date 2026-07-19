import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createResetPlan } from "./lib/shared-preview-reset-plan.mjs";
import { runReset } from "./reset-shared-preview.mjs";

const PREVIEW_KV = "preview-kv";
const PREVIEW_D1 = "preview-d1";
const PRODUCTION_KV = "production-kv";
const PRODUCTION_D1 = "production-d1";
const LOCAL_KV = "fixture-local-kv";
const LOCAL_D1 = "fixture-local-d1";
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("cleanup cannot bypass reset validation and smoke emits generated deployment evidence", () => {
  const workflow = readFileSync(
    join(repoRoot, ".github/workflows/reset-shared-preview.yml"),
    "utf8",
  );

  assert.match(workflow, /if: \$\{\{ always\(\) && steps\.reset\.outcome == 'success' \}\}/);
  assert.match(workflow, /node scripts\/resolve-shared-preview-deployed-sha\.mjs/);
  assert.match(
    workflow,
    /SPLITCH_SMOKE_COMMIT_SHA="\$SPLITCH_DEPLOYED_COMMIT_SHA" pnpm shared-preview:smoke/,
  );
  assert.match(workflow, /node scripts\/render-shared-preview-summary\.mjs reset/);
});

test("builds a mutation plan from positively identified shared-preview resources only", () => {
  const root = createFixture();
  const plan = createResetPlan(root);

  assert.deepEqual(plan.kvIds, [PREVIEW_KV]);
  assert.equal(plan.d1Id, PREVIEW_D1);
});

for (const [kind, options, message] of [
  [
    "KV production overlap",
    { previewKv: PRODUCTION_KV },
    /overlaps a production or local resource identifier/,
  ],
  [
    "KV local overlap",
    { previewKv: LOCAL_KV },
    /overlaps a production or local resource identifier/,
  ],
  [
    "D1 production overlap",
    { previewD1: PRODUCTION_D1 },
    /overlaps a production or local resource identifier/,
  ],
  [
    "D1 local overlap",
    { previewD1: LOCAL_D1 },
    /overlaps a production or local resource identifier/,
  ],
]) {
  test(`rejects a preview ${kind}`, () => {
    assert.throws(() => createResetPlan(createFixture(options)), message);
  });
}

test("runs only preview-scoped reset commands and Copy Pipe on demand", () => {
  const root = createFixture();
  const calls = [];
  const plan = createResetPlan(root);
  const previous = { ...process.env };
  Object.assign(process.env, {
    CLOUDFLARE_API_TOKEN: "test",
    CLOUDFLARE_ACCOUNT_ID: "test",
    TB_TOKEN: "test",
    TB_HOST: "https://api.example.test",
  });

  try {
    runReset(plan, {
      now: () => "2026-07-18T00:00:00.000Z",
      command(command, args, options = {}) {
        calls.push({ command, args, options });
        if (command === "tb" && args.includes("ls")) {
          return { stdout: "shared_preview\n" };
        }
        if (args.some((arg) => arg.includes("sqlite_master"))) {
          return {
            stdout: JSON.stringify([
              {
                results: [{ name: "apps" }, { name: "d1_migrations" }, { name: "sqlite_sequence" }],
              },
            ]),
          };
        }
        if (args.some((arg) => arg.includes("COUNT(*)"))) {
          return { stdout: JSON.stringify([{ results: [{ count: 0 }] }]) };
        }
        if (args.includes("key") && args.includes("list")) {
          const keyListCalls = calls.filter(
            (call) => call.args.includes("key") && call.args.includes("list"),
          );
          return {
            stdout: JSON.stringify(keyListCalls.length === 1 ? [{ name: "preview-key" }] : []),
          };
        }
        return { stdout: "" };
      },
    });
  } finally {
    for (const name of Object.keys(process.env)) {
      if (!(name in previous)) delete process.env[name];
    }
    Object.assign(process.env, previous);
  }

  const rendered = calls.flatMap(({ command, args }) => [command, ...args]).join(" ");
  assert.match(rendered, /--env shared-preview/);
  assert.match(rendered, /--branch=shared_preview copy run cp_deduped_exposures --wait --param/);
  assert.doesNotMatch(rendered, /copy run cp_deduped_exposures .*--yes/);
  assert.doesNotMatch(rendered, /cron|schedule/i);
  assert.doesNotMatch(rendered, /sqlite_sequence/);
  assert.doesNotMatch(rendered, new RegExp(PRODUCTION_KV));
  assert.doesNotMatch(rendered, new RegExp(PRODUCTION_D1));
  assert.doesNotMatch(rendered, /--env production/);
  assert.doesNotMatch(rendered, /--local/);
  for (const call of calls.filter(
    (call) => call.args.includes("kv") && call.args.includes("key"),
  )) {
    assert.ok(call.args.includes("--remote"));
  }
  assert.match(rendered, /SELECT COUNT\(\*\) AS count FROM "apps"/);
  for (const call of calls.filter(
    (call) =>
      call.args.includes("d1") &&
      call.args.includes("execute") &&
      (call.args.some((arg) => arg.includes("sqlite_master")) ||
        call.args.some((arg) => arg.includes("COUNT(*)"))),
  )) {
    assert.ok(call.args.includes("--json"));
  }
});

function createFixture({ previewKv = PREVIEW_KV, previewD1 = PREVIEW_D1 } = {}) {
  const root = mkdtempSync(join(tmpdir(), "splitch-reset-preview-test-"));
  const appDir = join(root, "apps", "test-api");
  const dbDir = join(root, "packages", "db");
  mkdirSync(appDir, { recursive: true });
  mkdirSync(dbDir, { recursive: true });
  writeFileSync(
    join(appDir, "wrangler.jsonc"),
    JSON.stringify({
      name: "splitch-test-api",
      kv_namespaces: [{ binding: "SESSION_STORE", id: LOCAL_KV }],
      d1_databases: [{ binding: "DB", database_id: LOCAL_D1 }],
      env: {
        "shared-preview": {
          name: "splitch-test-api-shared-preview",
          vars: { SPLITCH_PLATFORM_TARGET: "shared-preview" },
          kv_namespaces: [{ binding: "SESSION_STORE", id: previewKv }],
          d1_databases: [{ binding: "DB", database_id: previewD1 }],
        },
        production: {
          kv_namespaces: [{ binding: "SESSION_STORE", id: PRODUCTION_KV }],
          d1_databases: [{ binding: "DB", database_id: PRODUCTION_D1 }],
        },
      },
    }),
  );
  writeFileSync(
    join(dbDir, "wrangler.jsonc"),
    JSON.stringify({
      d1_databases: [{ binding: "DB", database_id: LOCAL_D1 }],
      env: {
        "shared-preview": { d1_databases: [{ binding: "DB", database_id: previewD1 }] },
        production: { d1_databases: [{ binding: "DB", database_id: PRODUCTION_D1 }] },
      },
    }),
  );
  return root;
}
