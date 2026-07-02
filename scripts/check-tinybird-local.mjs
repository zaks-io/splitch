import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";

const projectDir = "tinybird";

if (!existsSync(projectDir)) {
  console.error("tinybird:local: tinybird/ project directory is required.");
  process.exit(1);
}

validateSplitchDatasourceContracts(projectDir);
await requireTinybirdCli(projectDir);
await ensureTinybirdLocal(projectDir);
await run("tb", ["--no-version-warning", "--local", "build"], projectDir);
await run("tb", ["--no-version-warning", "--local", "test", "run"], projectDir);

function validateSplitchDatasourceContracts(root) {
  const rawEvents = readDatasource(root, "raw_events");
  const dedupedExposures = readDatasource(root, "deduped_exposures");

  requireColumns(rawEvents, [
    "`dedup_key`",
    "`server_received_at`",
    "`ingest_ts`",
    "`client_timestamp`",
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

  requireColumns(dedupedExposures, [
    "`app_id`",
    "`first_exposure_ts` DateTime64(3)",
    "`snapshot_ts` DateTime64(3)",
    "`watermark_ts` DateTime64(3)",
  ]);
  requireInstruction(
    dedupedExposures,
    /^ENGINE_SORTING_KEY "app_id, environment_id, experiment_id, run_id, variant, targeting_key_hash"$/m,
    "deduped_exposures sorting key must be app_id-first",
  );
}

function readDatasource(root, name) {
  const path = join(root, "datasources", `${name}.datasource`);
  if (!existsSync(path)) {
    fail(`missing datasource file: ${path}`);
  }
  return readFileSync(path, "utf8");
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

async function run(command, args, cwd) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: {
        ...process.env,
        TB_CLI_TELEMETRY_OPTOUT: "1",
        TB_VERSION_WARNING: "0",
      },
      stdio: "inherit",
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} failed with exit code ${code}`));
    });
  }).catch((error) => {
    console.error(`tinybird:local: ${error.message}`);
    process.exit(1);
  });
}

async function requireTinybirdCli(cwd) {
  const code = await quietExitCode("tb", ["--no-version-warning", "--version"], cwd);
  if (code !== 0) {
    fail("Tinybird CLI command `tb` is required. Install it with `curl https://tinybird.co | sh`.");
  }
}

async function ensureTinybirdLocal(cwd) {
  const started = await quietExitCode(
    "tb",
    ["--no-version-warning", "local", "start", "--daemon", "--skip-new-version"],
    cwd,
  );
  if (started !== 0) {
    fail("Tinybird Local is not ready and could not be started.");
  }
}

async function quietExitCode(command, args, cwd) {
  return await new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: {
        ...process.env,
        TB_CLI_TELEMETRY_OPTOUT: "1",
        TB_VERSION_WARNING: "0",
      },
      stdio: "ignore",
    });

    child.on("error", () => resolve(127));
    child.on("exit", (code) => resolve(code ?? 1));
  });
}
