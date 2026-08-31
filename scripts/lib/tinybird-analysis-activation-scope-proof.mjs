export const STRADDLE = "tk_straddle";

export function activationScopeProofs({ pipe, pipeNode, predicate }) {
  const candidates = pipeNode(pipe, "activation_candidates");
  const anchors = pipeNode(pipe, "activation_anchors");
  return [
    {
      name: "Activation App predicate",
      predicate: predicate(candidates, "AND raw_events.app_id = {{String(app_id)}}", {
        app_id: "app_1",
      }),
      query: (scope) =>
        activationScanAttack("app_id != 'app_1'", "environment_id = 'env_prod'", scope),
    },
    {
      name: "Activation Environment predicate",
      predicate: predicate(
        candidates,
        "AND raw_events.environment_id = {{String(environment_id)}}",
        {
          environment_id: "env_prod",
        },
      ),
      query: (scope) =>
        activationScanAttack("environment_id != 'env_prod'", "app_id = 'app_1'", scope),
    },
    {
      name: "Activation to Exposure App join predicate",
      predicate: predicate(anchors, "ON exposures.app_id = candidates.app_id"),
      query: (scope) => activationJoinAttack("candidates.app_id = 'app_2'", scope),
    },
    {
      name: "Activation to Exposure Environment join predicate",
      predicate: predicate(anchors, "AND exposures.environment_id = candidates.environment_id"),
      query: (scope) => activationJoinAttack("candidates.environment_id = 'env_dev'", scope),
    },
  ];
}

function activationScanAttack(foreign, sibling, scope) {
  return `
    SELECT
      countIf(${foreign}) AS attack_rows,
      countIf(${foreign} AND (${scope})) AS accepted_rows
    FROM raw_events
    WHERE ${sibling}
      AND type = 'activation'
      AND targeting_key_hash = '${STRADDLE}'`;
}

function activationJoinAttack(attack, scope) {
  return `
    SELECT
      count() AS attack_rows,
      countIf(${scope}) AS accepted_rows
    FROM raw_events AS exposures
    INNER JOIN raw_events AS candidates
      ON exposures.run_id = candidates.run_id
      AND exposures.id_type = candidates.id_type
      AND exposures.targeting_key_hash = candidates.targeting_key_hash
    WHERE exposures.app_id = 'app_1'
      AND exposures.environment_id = 'env_prod'
      AND exposures.type = 'exposure'
      AND exposures.targeting_key_hash = '${STRADDLE}'
      AND candidates.type = 'activation'
      AND ${attack}`;
}
