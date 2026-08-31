import { readFileSync } from "node:fs";

// The Entity whose targeting key collides across every tenant axis in the
// fixtures: one Exposure in app_1/env_prod, and Metric Events under the same
// hash in app_2/env_prod and app_1/env_dev.
const STRADDLE = "tk_straddle";
// The lookback the pre-period fixtures and the covariate test both use.
const PRE_PERIOD_LOOKBACK_MS = 86_400_000;
// `accepted_at` on serve_deduped_metric_events is the raw row's
// `server_received_at` (materialize_deduped_metric_events.pipe), so the raw
// datasource an attack query reads is the same clock the pipe windows on.
const STRADDLE_ANCHOR = `(
      SELECT first_exposure_ts FROM deduped_exposures
      WHERE app_id = 'app_1'
        AND environment_id = 'env_prod'
        AND experiment_id = 'exp_1'
        AND run_id = 'run_1'
        AND targeting_key_hash = '${STRADDLE}'
    )`;

export async function proveAnalysisScopePredicates(root, runQuery, fail) {
  await prove("analysis_metric_values", metricValueProofs(root), runQuery, fail);
  await prove("analysis_metric_values_batch", batchMetricValueProofs(root), runQuery, fail);
  await prove("analysis_pre_period_covariates", prePeriodProofs(root), runQuery, fail);
  await prove("analysis_pre_period_covariates_batch", batchPrePeriodProofs(root), runQuery, fail);
  await prove("analysis_ratio_metric_values", ratioProofs(root), runQuery, fail);
}

function batchMetricValueProofs(root) {
  const pipe = readPipe(root, "analysis_metric_values_batch");
  return scopedEventAndJoinProofs(
    pipeNode(pipe, "scoped_metric_events"),
    pipeNode(pipe, "operand_values"),
    "batched Metric Event",
    "",
  );
}

function batchPrePeriodProofs(root) {
  const pipe = readPipe(root, "analysis_pre_period_covariates_batch");
  return scopedEventAndJoinProofs(
    pipeNode(pipe, "scoped_pre_period_events"),
    pipeNode(pipe, "pre_period_values"),
    "batched pre-period Metric Event",
    PRE_PERIOD_BOUNDS,
  );
}

function scopedEventAndJoinProofs(events, values, label, bounds) {
  const prePeriod = bounds.length > 0;
  return [
    {
      name: `${label} App predicate`,
      predicate: predicate(events, "WHERE app_id = {{String(app_id)}}", { app_id: "app_1" }),
      query: (scope) =>
        scanAttack("app_id != 'app_1'", "environment_id = 'env_prod'", scope, bounds),
    },
    {
      name: `${label} Environment predicate`,
      predicate: predicate(events, "AND environment_id = {{String(environment_id)}}", {
        environment_id: "env_prod",
      }),
      query: (scope) =>
        scanAttack("environment_id != 'env_prod'", "app_id = 'app_1'", scope, bounds),
    },
    {
      name: `${label} to Exposure App join predicate`,
      predicate: predicate(values, "ON events.app_id = exposures.app_id"),
      query: (scope) =>
        prePeriod
          ? prePeriodJoinAttack(FOREIGN_APP, scope)
          : windowlessJoinAttack(FOREIGN_APP, scope),
    },
    {
      name: `${label} to Exposure Environment join predicate`,
      predicate: predicate(values, "AND events.environment_id = exposures.environment_id"),
      query: (scope) =>
        prePeriod
          ? prePeriodJoinAttack(FOREIGN_ENVIRONMENT, scope)
          : windowlessJoinAttack(FOREIGN_ENVIRONMENT, scope),
    },
  ];
}

function metricValueProofs(root) {
  const pipe = readPipe(root, "analysis_metric_values");
  const events = pipeNode(pipe, "scoped_metric_events");
  const values = pipeNode(pipe, "binomial_entity_values");
  return [
    {
      name: "scoped Metric Events App predicate",
      predicate: predicate(events, "WHERE app_id = {{String(app_id)}}", { app_id: "app_1" }),
      query: (scope) => scanAttack("app_id != 'app_1'", "environment_id = 'env_prod'", scope, ""),
    },
    {
      name: "scoped Metric Events Environment predicate",
      predicate: predicate(events, "AND environment_id = {{String(environment_id)}}", {
        environment_id: "env_prod",
      }),
      query: (scope) => scanAttack("environment_id != 'env_prod'", "app_id = 'app_1'", scope, ""),
    },
    {
      name: "Metric Event to Exposure App join predicate",
      predicate: predicate(values, "ON events.app_id = exposures.app_id"),
      query: (scope) => windowlessJoinAttack(FOREIGN_APP, scope),
    },
    {
      name: "Metric Event to Exposure Environment join predicate",
      predicate: predicate(values, "AND events.environment_id = exposures.environment_id"),
      query: (scope) => windowlessJoinAttack(FOREIGN_ENVIRONMENT, scope),
    },
    {
      name: "final Metric Event App predicate",
      predicate: predicate(values, "AND events.app_id = {{String(app_id)}}", { app_id: "app_1" }),
      query: (scope) => windowlessJoinAttack(FOREIGN_APP, scope),
    },
    {
      name: "final Metric Event Environment predicate",
      predicate: predicate(values, "AND events.environment_id = {{String(environment_id)}}", {
        environment_id: "env_prod",
      }),
      query: (scope) => windowlessJoinAttack(FOREIGN_ENVIRONMENT, scope),
    },
  ];
}

/**
 * The same six axes on the covariate pipe. Every attack row here is placed
 * INSIDE the pre-period window, because a foreign row the window already
 * excludes proves nothing about the tenant predicate that is supposed to
 * exclude it.
 */
function prePeriodProofs(root) {
  const pipe = readPipe(root, "analysis_pre_period_covariates");
  const events = pipeNode(pipe, "scoped_pre_period_events");
  const values = pipeNode(pipe, "binomial_pre_period_values");
  return [
    {
      name: "scoped pre-period Metric Events App predicate",
      predicate: predicate(events, "WHERE app_id = {{String(app_id)}}", { app_id: "app_1" }),
      query: (scope) =>
        scanAttack("app_id != 'app_1'", "environment_id = 'env_prod'", scope, PRE_PERIOD_BOUNDS),
    },
    {
      name: "scoped pre-period Metric Events Environment predicate",
      predicate: predicate(events, "AND environment_id = {{String(environment_id)}}", {
        environment_id: "env_prod",
      }),
      query: (scope) =>
        scanAttack("environment_id != 'env_prod'", "app_id = 'app_1'", scope, PRE_PERIOD_BOUNDS),
    },
    {
      name: "pre-period Metric Event to Exposure App join predicate",
      predicate: predicate(values, "ON events.app_id = exposures.app_id"),
      query: (scope) => prePeriodJoinAttack(FOREIGN_APP, scope),
    },
    {
      name: "pre-period Metric Event to Exposure Environment join predicate",
      predicate: predicate(values, "AND events.environment_id = exposures.environment_id"),
      query: (scope) => prePeriodJoinAttack(FOREIGN_ENVIRONMENT, scope),
    },
    {
      name: "final pre-period Metric Event App predicate",
      predicate: predicate(values, "AND events.app_id = {{String(app_id)}}", { app_id: "app_1" }),
      query: (scope) => prePeriodJoinAttack(FOREIGN_APP, scope),
    },
    {
      name: "final pre-period Metric Event Environment predicate",
      predicate: predicate(values, "AND events.environment_id = {{String(environment_id)}}", {
        environment_id: "env_prod",
      }),
      query: (scope) => prePeriodJoinAttack(FOREIGN_ENVIRONMENT, scope),
    },
  ];
}

/**
 * The Ratio pipe reads serve_deduped_metric_events twice under two independent
 * predicate sets, so each operand gets the same raw-event axes the
 * single-source pipes get. Its tenant-scoped final node reads the per-Entity
 * aggregates, not raw rows, so the four axes below are the whole raw surface.
 */
function ratioProofs(root) {
  const pipe = readPipe(root, "analysis_ratio_metric_values");
  return ["numerator", "denominator"].flatMap((operand) =>
    operandProofs(
      pipeNode(pipe, `scoped_${operand}_events`),
      pipeNode(pipe, `${operand}_values`),
      operand,
    ),
  );
}

function operandProofs(events, values, operand) {
  return [
    {
      name: `scoped ${operand} Metric Events App predicate`,
      predicate: predicate(events, "WHERE app_id = {{String(app_id)}}", { app_id: "app_1" }),
      query: (scope) => scanAttack("app_id != 'app_1'", "environment_id = 'env_prod'", scope, ""),
    },
    {
      name: `scoped ${operand} Metric Events Environment predicate`,
      predicate: predicate(events, "AND environment_id = {{String(environment_id)}}", {
        environment_id: "env_prod",
      }),
      query: (scope) => scanAttack("environment_id != 'env_prod'", "app_id = 'app_1'", scope, ""),
    },
    {
      name: `${operand} Metric Event to Exposure App join predicate`,
      predicate: predicate(values, "ON events.app_id = exposures.app_id"),
      query: (scope) => windowlessJoinAttack(FOREIGN_APP, scope),
    },
    {
      name: `${operand} Metric Event to Exposure Environment join predicate`,
      predicate: predicate(values, "AND events.environment_id = exposures.environment_id"),
      query: (scope) => windowlessJoinAttack(FOREIGN_ENVIRONMENT, scope),
    },
  ];
}

const FOREIGN_APP = "events.app_id = 'app_2' AND events.environment_id = 'env_prod'";
const FOREIGN_ENVIRONMENT = "events.app_id = 'app_1' AND events.environment_id = 'env_dev'";

const PRE_PERIOD_BOUNDS = `
      AND server_received_at >= subtractMilliseconds(${STRADDLE_ANCHOR}, ${PRE_PERIOD_LOOKBACK_MS})
      AND server_received_at < ${STRADDLE_ANCHOR}`;

async function prove(pipeName, proofs, runQuery, fail) {
  for (const proof of proofs) {
    const result = await query(pipeName, proof.query(proof.predicate), runQuery, fail);
    if (result.attack_rows < 1) {
      fail(`${pipeName}: ${proof.name} has no colliding foreign row to reject`);
    }
    if (result.accepted_rows !== 0) {
      fail(`${pipeName}: ${proof.name} accepted ${result.accepted_rows} foreign row(s)`);
    }
  }
  console.log(
    `✓ ${pipeName}: ${proofs.length}/${proofs.length} isolated scope predicates rejected colliding rows`,
  );
}

function readPipe(root, name) {
  return readFileSync(`${root}/pipes/${name}.pipe`, "utf8");
}

function pipeNode(pipe, name) {
  const start = pipe.indexOf(`NODE ${name}\n`);
  if (start === -1) return "";
  const end = pipe.indexOf("\nNODE ", start + 1);
  return pipe.slice(start, end === -1 ? undefined : end);
}

function predicate(node, source, params = {}) {
  const normalizedNode = normalizeSql(node);
  const normalizedSource = normalizeSql(source);
  const occurrences = normalizedNode.split(normalizedSource).length - 1;
  if (occurrences === 0) return "1";
  if (occurrences > 1) throw new Error(`analysis scope predicate is duplicated: ${source}`);
  let sql = normalizedSource.replace(/^(?:WHERE|AND|ON)\s+/, "");
  for (const [name, value] of Object.entries(params)) {
    sql = sql.replace(`{{String(${name})}}`, `'${value}'`);
  }
  return sql;
}

function normalizeSql(sql) {
  return sql
    .replace(/\{\{\s*/gu, "{{")
    .replace(/\s*\}\}/gu, "}}")
    .replace(/\s+/gu, " ")
    .trim();
}

/** One predicate held against the raw Metric Events it alone is meant to exclude. */
function scanAttack(foreign, sibling, scope, bounds) {
  return `
    SELECT
      countIf(${foreign}) AS attack_rows,
      countIf(${foreign} AND (${scope})) AS accepted_rows
    FROM metric_events
    WHERE ${sibling}
      AND targeting_key_hash = '${STRADDLE}'${bounds}`;
}

function windowlessJoinAttack(attack, scope) {
  return `
    SELECT
      count() AS attack_rows,
      countIf(${scope}) AS accepted_rows
    FROM raw_events AS exposures
    INNER JOIN metric_events AS events
      ON events.id_type = exposures.id_type
      AND events.targeting_key_hash = exposures.targeting_key_hash
    WHERE exposures.app_id = 'app_1'
      AND exposures.environment_id = 'env_prod'
      AND exposures.type = 'exposure'
      AND exposures.targeting_key_hash = '${STRADDLE}'
      AND ${attack}`;
}

/** The join above, narrowed to Metric Events that fall inside the pre-period window. */
function prePeriodJoinAttack(attack, scope) {
  return `
    SELECT
      count() AS attack_rows,
      countIf(${scope}) AS accepted_rows
    FROM deduped_exposures AS exposures
    INNER JOIN metric_events AS events
      ON events.id_type = exposures.id_type
      AND events.targeting_key_hash = exposures.targeting_key_hash
    WHERE exposures.app_id = 'app_1'
      AND exposures.environment_id = 'env_prod'
      AND exposures.experiment_id = 'exp_1'
      AND exposures.run_id = 'run_1'
      AND exposures.targeting_key_hash = '${STRADDLE}'
      AND ${attack}
      AND events.server_received_at >= subtractMilliseconds(
        exposures.first_exposure_ts,
        ${PRE_PERIOD_LOOKBACK_MS}
      )
      AND events.server_received_at < exposures.first_exposure_ts`;
}

async function query(pipeName, sql, runQuery, fail) {
  const raw = await runQuery(sql);
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    fail(`${pipeName} scope query returned invalid JSON`);
  }
  const row = body.data?.[0];
  if (!row || typeof row.attack_rows !== "number" || typeof row.accepted_rows !== "number") {
    fail(`${pipeName} scope query returned an invalid result`);
  }
  return row;
}
