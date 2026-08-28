import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { proveAnalysisScopePredicates } from "./lib/tinybird-analysis-scope-proof.mjs";
import { assertEnvironmentExposureStatusContract } from "./lib/tinybird-exposure-status-contract.mjs";
import { assertMetricStubsRetiredWhenMetricEventsExist } from "./lib/tinybird-metric-stub-tripwire.mjs";
import { output, quietExitCode, quietExitCodeWithInput, run } from "./lib/tinybird-process.mjs";
import { acquireMachineLock } from "./machine-lock.mjs";

const projectDir = ".";
const projectConfigPath = "tinybird.config.json";
const tinybirdRoot = "infra/tinybird";
const testsDir = join(tinybirdRoot, "tests");
const FIRST_TOUCH_RULE =
  /if\(\s*countIf\(isNull\(variant\)\)[\s\S]*?AS variant,\s*min\(exposure_at\) AS (?:first_exposure_ts|encounter_ts)/;

if (!existsSync(projectConfigPath)) {
  console.error("tinybird:local: tinybird.config.json is required.");
  process.exit(1);
}

if (!existsSync(tinybirdRoot)) {
  console.error("tinybird:local: infra/tinybird project files are required.");
  process.exit(1);
}

validateSplitchDatasourceContracts(tinybirdRoot);
await requireTinybirdCli(projectDir);

// The tinybird-local container is a machine-global singleton; serialize
// against concurrent runs from other sessions/worktrees.
const lock = await acquireMachineLock("tinybird-local");
try {
  const tokens = await generateTinybirdLocalTokens(projectDir);
  await resetTinybirdLocal(projectDir, tokens);
  await run("tb", ["--no-version-warning", "build"], projectDir);
  await proveExposureAtCompatibility(projectDir);
  await proveAnalysisScopePredicates(
    tinybirdRoot,
    (sql) => output("tb", ["--no-version-warning", "--output", "json", "sql", sql], projectDir),
    fail,
  );
  if (hasTinybirdTests(testsDir)) {
    await run("tb", ["--no-version-warning", "test", "run"], projectDir);
  }
} finally {
  await removeTinybirdLocal(projectDir);
  lock.release();
}

function validateSplitchDatasourceContracts(root) {
  const rawEvents = readDatasource(root, "raw_events");
  const rawEvaluations = readDatasource(root, "raw_evaluations");
  const dedupedExposures = readDatasource(root, "deduped_exposures");

  requireColumns(rawEvents, [
    "`dedup_key`",
    "`exposure_at` DateTime64(3) `json:$.exposure_at` DEFAULT server_received_at",
    "`server_received_at`",
    "`ingest_ts` DateTime64(3) `json:$.ingest_ts` DEFAULT now64(3)",
    "`client_timestamp` Nullable(DateTime64(3))",
    "`activation_ts` Nullable(DateTime64(3))",
    "`variant` Nullable(String)",
    "`sdk_version` Nullable(String)",
    "`is_holdover` UInt8",
    "`counterfactual` UInt8",
  ]);
  requireInstruction(
    rawEvents,
    /^ENGINE_PARTITION_KEY "toYYYYMM\(server_received_at\)"$/m,
    "raw_events partition key must use server_received_at",
  );

  requireColumns(rawEvaluations, [
    "`dedup_key`",
    "`event_id`",
    "`organization_id`",
    "`app_id`",
    "`environment_id`",
    "`server_received_at` DateTime64(3)",
    "`evaluation_count` Nullable(UInt32)",
    "`is_batch` Nullable(UInt8)",
    "`is_cached` Nullable(UInt8)",
    "`has_exposure` Nullable(UInt8)",
  ]);
  requireInstruction(
    rawEvaluations,
    /^ENGINE_SORTING_KEY "organization_id, app_id, environment_id, server_received_at"$/m,
    "raw_evaluations sorting key must start with organization_id",
  );
  requireInstruction(
    rawEvaluations,
    /^# DEDUP_KEY=dedup_key$/m,
    "raw_evaluations must declare splitch DEDUP_KEY=dedup_key",
  );
  requireInstruction(
    readFileSync(join(root, "pipes", "analysis_evaluation_usage.pipe"), "utf8"),
    /GROUP BY dedup_key/,
    "evaluation usage pipe must deduplicate logical Evaluation rows",
  );
  requireInstruction(
    rawEvents,
    /^ENGINE_SORTING_KEY "app_id, environment_id, experiment_id, run_id, server_received_at, targeting_key_hash"$/m,
    "raw_events sorting key must be app_id-first",
  );
  requireInstruction(
    rawEvents,
    /^ENGINE_TTL "toDateTime\(server_received_at\) \+ toIntervalDay\(90\)"$/m,
    "raw_events retention TTL must be 90 days from server_received_at",
  );
  requireInstruction(
    rawEvents,
    /^# DEDUP_KEY=dedup_key$/m,
    "raw_events must declare splitch DEDUP_KEY=dedup_key",
  );
  requireInstruction(
    rawEvents,
    /^(?![\s\S]*FORWARD_QUERY)/,
    "raw_events must not retain the one-shot exposure_at migration query",
  );

  requireColumns(dedupedExposures, [
    "`app_id`",
    "`first_exposure_ts` DateTime64(3)",
    "`snapshot_ts` DateTime64(3)",
    "`watermark_ts` DateTime64(3)",
  ]);
  requireInstruction(
    dedupedExposures,
    /^ENGINE_SORTING_KEY "app_id, environment_id, experiment_id, run_id, variant, entity_family_hash"$/m,
    "deduped_exposures sorting key must be app_id-first",
  );

  requireIdenticalFirstTouchRule(root);
  assertEnvironmentExposureStatusContract(root, fail);
  // SPL-290 empty Metric stubs must die the moment metric_events lands; a
  // pipe-header comment alone would let Results keep reporting zero-event
  // Metrics forever after real ingest ships.
  assertMetricStubsRetiredWhenMetricEventsExist(root, fail);
}

async function proveExposureAtCompatibility(cwd) {
  const raw = await output(
    "tb",
    [
      "--no-version-warning",
      "--output",
      "json",
      "sql",
      `SELECT
        dedup_key,
        toUnixTimestamp64Milli(exposure_at) AS exposure_at_ms,
        toUnixTimestamp64Milli(server_received_at) AS server_received_at_ms,
        toUnixTimestamp64Milli(ingest_ts) AS ingest_ts_ms,
        isNull(client_timestamp) AS client_timestamp_is_null
      FROM raw_events
      WHERE dedup_key IN ('compat-new-exposure-at', 'compat-old-exposure-at')
      ORDER BY dedup_key`,
    ],
    cwd,
  );
  let rows;
  try {
    rows = JSON.parse(raw).data;
  } catch {
    fail("raw_events exposure_at compatibility query returned invalid JSON");
  }
  const newRow = rows?.find((row) => row.dedup_key === "compat-new-exposure-at");
  const oldRow = rows?.find((row) => row.dedup_key === "compat-old-exposure-at");
  if (newRow?.exposure_at_ms !== 1_783_641_540_000) {
    fail("raw_events did not preserve an explicit exposure_at");
  }
  if (
    oldRow?.exposure_at_ms !== oldRow?.server_received_at_ms ||
    oldRow?.server_received_at_ms !== 1_783_641_600_000
  ) {
    fail("raw_events did not project a retained row's exposure_at from server_received_at");
  }
  if (
    typeof newRow?.ingest_ts_ms !== "number" ||
    typeof oldRow?.ingest_ts_ms !== "number" ||
    newRow.ingest_ts_ms < newRow.server_received_at_ms ||
    oldRow.ingest_ts_ms < oldRow.server_received_at_ms
  ) {
    fail("raw_events did not assign ingest_ts when producers omitted it");
  }
  if (oldRow?.client_timestamp_is_null !== 1) {
    fail("raw_events did not accept an omitted diagnostic client_timestamp");
  }
  console.log(
    "✓ raw_events: mixed old/new rows preserve exposure_at and Tinybird-owned ingest metadata",
  );
}

// The snapshot Copy Pipe and the real-time tail are separate files that must agree
// on first touch and on variant quarantine. If they drift, the two lambda layers
// disagree about the same Entity and the union silently reports a variant conflict
// that never happened.
function requireIdenticalFirstTouchRule(root) {
  const sources = [
    join(root, "copies", "cp_deduped_exposures.pipe"),
    join(root, "pipes", "serve_deduped_exposures.pipe"),
  ];
  const rules = sources.map((path) => {
    const match = FIRST_TOUCH_RULE.exec(readFileSync(path, "utf8"));
    if (!match) {
      fail(`missing first-touch dedup rule in ${path}`);
    }
    return match[0].replace(/encounter_ts/g, "first_exposure_ts").replace(/\s+/g, " ");
  });
  if (rules[0] !== rules[1]) {
    fail(
      `first-touch dedup rule differs between ${sources[0]} and ${sources[1]}; the snapshot and tail layers must compute it identically`,
    );
  }
}

function readDatasource(root, name) {
  const path = join(root, "datasources", `${name}.datasource`);
  if (!existsSync(path)) {
    fail(`missing datasource file: ${path}`);
  }
  return readFileSync(path, "utf8");
}

function hasTinybirdTests(path) {
  if (!existsSync(path)) {
    return false;
  }
  return readdirSync(path).some((file) => file.endsWith(".yaml") || file.endsWith(".yml"));
}

function requireColumns(contents, columns) {
  for (const column of columns) {
    if (!contents.includes(column)) {
      fail(`missing required Tinybird column contract: ${column}`);
    }
  }
}

function requireInstruction(contents, pattern, message) {
  if (!pattern.test(contents)) {
    fail(message);
  }
}

function fail(message) {
  console.error(`tinybird:local: ${message}`);
  process.exit(1);
}

async function requireTinybirdCli(cwd) {
  const code = await quietExitCode("tb", ["--no-version-warning", "--version"], cwd);
  if (code !== 0) {
    fail("Tinybird CLI command `tb` is required. Install it with `curl https://tinybird.co | sh`.");
  }
}

async function generateTinybirdLocalTokens(cwd) {
  const raw = await output(
    "tb",
    ["--no-version-warning", "--output", "json", "local", "generate-tokens"],
    cwd,
  );
  try {
    const parsed = JSON.parse(raw);
    if (!parsed.user_token || !parsed.workspace_token) {
      fail("Tinybird Local token generation did not return both required tokens.");
    }
    return {
      userToken: parsed.user_token,
      workspaceToken: parsed.workspace_token,
    };
  } catch {
    fail("Tinybird Local token generation returned invalid JSON.");
  }
}

async function resetTinybirdLocal(cwd, tokens) {
  await quietExitCode("tb", ["--no-version-warning", "local", "stop"], cwd);
  await quietExitCodeWithInput("tb", ["--no-version-warning", "local", "remove"], cwd, "y\n");
  await run(
    "tb",
    ["--no-version-warning", "local", "start", "--daemon", "--skip-new-version"],
    cwd,
    {
      env: {
        TB_LOCAL_USER_TOKEN: tokens.userToken,
        TB_LOCAL_WORKSPACE_TOKEN: tokens.workspaceToken,
      },
    },
  );
}

async function removeTinybirdLocal(cwd) {
  await quietExitCode("tb", ["--no-version-warning", "local", "stop"], cwd);
  await quietExitCodeWithInput("tb", ["--no-version-warning", "local", "remove"], cwd, "y\n");
}
