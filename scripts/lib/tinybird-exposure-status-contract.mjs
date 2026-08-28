import { readFileSync } from "node:fs";
import { join } from "node:path";

export function assertEnvironmentExposureStatusContract(root, fail) {
  const datasource = readDatasource(root, "environment_exposure_status_state");
  const deletions = readDatasource(root, "environment_exposure_status_deletions");
  requireColumns(
    datasource,
    [
      "`app_id`",
      "`environment_id`",
      "`first_exposure_state` AggregateFunction(min, DateTime64(3))",
    ],
    fail,
  );
  requireInstruction(
    datasource,
    /^ENGINE_SORTING_KEY "app_id, environment_id"$/m,
    "Environment Exposure status sorting key must be App/Environment scoped",
    fail,
  );
  requireInstruction(
    datasource,
    /^(?![\s\S]*FORWARD_QUERY)/,
    "Environment Exposure status must not retain its one-shot migration query",
    fail,
  );
  requireIdentityFree(datasource, "Environment Exposure status", fail);

  requireColumns(deletions, ["`app_id`", "`environment_id`"], fail);
  requireInstruction(
    deletions,
    /^ENGINE_SORTING_KEY "app_id, environment_id"$/m,
    "Environment Exposure status deletion suppression must be App/Environment scoped",
    fail,
  );
  requireIdentityFree(deletions, "Environment Exposure status deletion suppression", fail);

  const materialization = readFileSync(
    join(root, "materializations", "materialize_environment_exposure_status.pipe"),
    "utf8",
  );
  const endpoint = readFileSync(join(root, "pipes", "environment_exposure_status.pipe"), "utf8");
  requireInstruction(
    materialization,
    /WHERE type = 'exposure'/,
    "Environment Exposure status must materialize real Exposure rows only",
    fail,
  );
  requireInstruction(
    endpoint,
    /NOT EXISTS[\s\S]*FROM environment_exposure_status_deletions/,
    "Environment Exposure status must suppress state for deleted Apps and Environments",
    fail,
  );
  requireInstruction(
    materialization,
    /minState\(exposure_at\) AS first_exposure_state/,
    "Environment Exposure status must preserve the earliest encounter timestamp",
    fail,
  );
  requireInstruction(
    materialization,
    /GROUP BY app_id, environment_id/,
    "Environment Exposure status must group by both tenant axes",
    fail,
  );
  requireInstruction(
    materialization,
    /TYPE MATERIALIZED[\s\S]*DATASOURCE environment_exposure_status_state/,
    "Environment Exposure status must continuously materialize into its durable datasource",
    fail,
  );
  requireInstruction(
    materialization,
    /Deployment population backfills every retained raw Exposure/,
    "Environment Exposure status must declare its deployment backfill",
    fail,
  );
  if (/BACKFILL\s+skip/u.test(materialization) || /BACKFILL\s+skip/u.test(datasource)) {
    fail("Environment Exposure status must not skip deployment backfill");
  }
}

function readDatasource(root, name) {
  return readFileSync(join(root, "datasources", `${name}.datasource`), "utf8");
}

function requireColumns(contents, columns, fail) {
  for (const column of columns) {
    if (!contents.includes(column)) fail(`missing required Tinybird column contract: ${column}`);
  }
}

function requireInstruction(contents, pattern, message, fail) {
  if (!pattern.test(contents)) fail(message);
}

function requireIdentityFree(contents, label, fail) {
  if (/targeting_key|id_type|ENGINE_TTL/u.test(contents)) {
    fail(`${label} must not retain Entity identity or expire`);
  }
}
