import { readFileSync } from "node:fs";

export async function proveAnalysisMetricScopePredicates(root, runQuery, fail) {
  const pipe = readFileSync(`${root}/pipes/analysis_metric_values.pipe`, "utf8");
  const metricEvents = pipeNode(pipe, "scoped_metric_events");
  const values = pipeNode(pipe, "binomial_entity_values");
  const proofs = [
    {
      name: "scoped Metric Events App predicate",
      predicate: predicate(metricEvents, "WHERE app_id = {{String(app_id)}}", {
        app_id: "app_1",
      }),
      query: (scope) => `
        SELECT
          countIf(app_id != 'app_1') AS attack_rows,
          countIf(app_id != 'app_1' AND (${scope})) AS accepted_rows
        FROM metric_events
        WHERE environment_id = 'env_prod'
          AND targeting_key_hash = 'tk_straddle'`,
    },
    {
      name: "scoped Metric Events Environment predicate",
      predicate: predicate(metricEvents, "AND environment_id = {{String(environment_id)}}", {
        environment_id: "env_prod",
      }),
      query: (scope) => `
        SELECT
          countIf(environment_id != 'env_prod') AS attack_rows,
          countIf(environment_id != 'env_prod' AND (${scope})) AS accepted_rows
        FROM metric_events
        WHERE app_id = 'app_1'
          AND targeting_key_hash = 'tk_straddle'`,
    },
    {
      name: "Metric Event to Exposure App join predicate",
      predicate: predicate(values, "ON events.app_id = exposures.app_id"),
      query: (scope) =>
        joinedAttackQuery("events.app_id = 'app_2' AND events.environment_id = 'env_prod'", scope),
    },
    {
      name: "Metric Event to Exposure Environment join predicate",
      predicate: predicate(values, "AND events.environment_id = exposures.environment_id"),
      query: (scope) =>
        joinedAttackQuery("events.app_id = 'app_1' AND events.environment_id = 'env_dev'", scope),
    },
    {
      name: "final Metric Event App predicate",
      predicate: predicate(values, "AND events.app_id = {{String(app_id)}}", {
        app_id: "app_1",
      }),
      query: (scope) =>
        joinedAttackQuery("events.app_id = 'app_2' AND events.environment_id = 'env_prod'", scope),
    },
    {
      name: "final Metric Event Environment predicate",
      predicate: predicate(values, "AND events.environment_id = {{String(environment_id)}}", {
        environment_id: "env_prod",
      }),
      query: (scope) =>
        joinedAttackQuery("events.app_id = 'app_1' AND events.environment_id = 'env_dev'", scope),
    },
  ];

  for (const proof of proofs) {
    const result = await query(proof.query(proof.predicate), runQuery, fail);
    if (result.attack_rows < 1) {
      fail(`analysis_metric_values: ${proof.name} has no colliding foreign row to reject`);
    }
    if (result.accepted_rows !== 0) {
      fail(`analysis_metric_values: ${proof.name} accepted ${result.accepted_rows} foreign row(s)`);
    }
  }
  console.log("✓ analysis_metric_values: 6/6 isolated scope predicates rejected colliding rows");
}

function pipeNode(pipe, name) {
  const start = pipe.indexOf(`NODE ${name}\n`);
  if (start === -1) return "";
  const end = pipe.indexOf("\nNODE ", start + 1);
  return pipe.slice(start, end === -1 ? undefined : end);
}

function predicate(node, source, params = {}) {
  const occurrences = node.split(source).length - 1;
  if (occurrences === 0) return "1";
  if (occurrences > 1) throw new Error(`analysis_metric_values predicate is duplicated: ${source}`);
  let sql = source.replace(/^(?:WHERE|AND|ON)\s+/, "");
  for (const [name, value] of Object.entries(params)) {
    sql = sql.replace(`{{String(${name})}}`, `'${value}'`);
  }
  return sql;
}

function joinedAttackQuery(attack, scope) {
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
      AND exposures.targeting_key_hash = 'tk_straddle'
      AND ${attack}`;
}

async function query(sql, runQuery, fail) {
  const raw = await runQuery(sql);
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    fail("analysis_metric_values scope query returned invalid JSON");
  }
  const row = body.data?.[0];
  if (!row || typeof row.attack_rows !== "number" || typeof row.accepted_rows !== "number") {
    fail("analysis_metric_values scope query returned an invalid result");
  }
  return row;
}
