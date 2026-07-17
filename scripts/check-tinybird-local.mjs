import { existsSync, readdirSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";

const projectDir = ".";
const projectConfigPath = "tinybird.config.json";
const tinybirdRoot = "infra/tinybird";
const testsDir = join(tinybirdRoot, "tests");

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
const tokens = await generateTinybirdLocalTokens(projectDir);

try {
  await resetTinybirdLocal(projectDir, tokens);
  await run("tb", ["--no-version-warning", "build"], projectDir);
  if (hasTinybirdTests(testsDir)) {
    await run("tb", ["--no-version-warning", "test", "run"], projectDir);
  }
} finally {
  await removeTinybirdLocal(projectDir);
}

function validateSplitchDatasourceContracts(root) {
  const rawEvents = readDatasource(root, "raw_events");
  const rawEvaluations = readDatasource(root, "raw_evaluations");
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

function hasTinybirdTests(path) {
  if (!existsSync(path)) {
    return false;
  }
  return readdirSync(path).some((file) => file.endsWith(".test"));
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

async function run(command, args, cwd, options = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: {
        ...process.env,
        ...options.env,
        TB_CLI_TELEMETRY_OPTOUT: "1",
        TB_VERSION_WARNING: "0",
      },
      stdio: options.input ? ["pipe", "inherit", "inherit"] : "inherit",
    });

    if (options.input) {
      child.stdin.end(options.input);
    }

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

async function output(command, args, cwd) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: {
        ...process.env,
        TB_CLI_TELEMETRY_OPTOUT: "1",
        TB_VERSION_WARNING: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} failed with exit code ${code}: ${stderr}`));
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

async function quietExitCodeWithInput(command, args, cwd, input) {
  return await new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: {
        ...process.env,
        TB_CLI_TELEMETRY_OPTOUT: "1",
        TB_VERSION_WARNING: "0",
      },
      stdio: ["pipe", "ignore", "ignore"],
    });

    child.stdin.end(input);
    child.on("error", () => resolve(127));
    child.on("exit", (code) => resolve(code ?? 1));
  });
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
