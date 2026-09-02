import { PROPAGATION_WINDOW_MS } from "./constants.mjs";

const RESULT_STABILITY_WINDOW_MS = 2_000;

export function assertToolParity(tools) {
  const names = new Set(tools.map((tool) => tool.name));
  const required = [
    "organizations_list",
    "apps_list",
    "apps_create",
    "apps_delete",
    "client_key_get",
    "client_key_rotate",
    "flags_create",
    "flag_config_update",
    "flag_targeting_rules_replace",
    "flags_test_eval",
    "experiments_create",
    "experiments_start",
    "experiments_delete",
    "runs_end",
    "experiment_results_get",
    "event_definitions_create",
    "event_definition_versions_create",
    "metrics_create",
    "metrics_delete",
    "flags_delete",
    "approval_request_reviews_create",
  ];
  const missing = required.filter((name) => !names.has(name));
  if (missing.length > 0) {
    throw new Error(`MCP/CLI route parity is missing operations: ${missing.join(", ")}`);
  }
  return { required, observed: [...names].sort(), missing };
}

export async function pollResults(mcpClient, scope, expectedDeduped = 0) {
  const deadline = Date.now() + PROPAGATION_WINDOW_MS;
  let lastError;
  let stableSince;
  while (Date.now() <= deadline) {
    try {
      const results = await mcpClient.callTool("experiment_results_get", scope);
      assertExposureHealth(results, expectedDeduped);
      stableSince ??= Date.now();
      if (Date.now() - stableSince >= RESULT_STABILITY_WINDOW_MS) return results;
    } catch (error) {
      lastError = error;
      stableSince = undefined;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("experiment_results_get did not converge within the propagation window");
}

export function assertExposureHealth(results, expectedDeduped) {
  const health = results?.stats?.health;
  if (!health || typeof health !== "object") {
    throw new Error(`experiment_results_get omitted stats.health: ${JSON.stringify(results)}`);
  }
  if (dedupedTotal(results) !== expectedDeduped) {
    throw new Error(`expected ${expectedDeduped} deduped Exposures, got ${dedupedTotal(results)}`);
  }
  if (exposureTotal(results) !== expectedDeduped) {
    throw new Error(`expected ${expectedDeduped} raw Exposures, got ${exposureTotal(results)}`);
  }
  if (health.multiple_count !== 0) {
    throw new Error(`expected multiple_count=0, got ${health.multiple_count}`);
  }
  if (
    Object.hasOwn(health.exposure_counts ?? {}, "__multiple__") ||
    Object.hasOwn(health.deduped_counts ?? {}, "__multiple__")
  ) {
    throw new Error("experiment_results_get included __multiple__ quarantine counts");
  }
}

export function summarizeExposureHealth(results) {
  if (!results) throw new Error("hosted onboarding run produced no Experiment results evidence");
  return {
    runId: results.run_id,
    exposureCounts: results.stats.health.exposure_counts,
    exposureTotal: exposureTotal(results),
    dedupedCounts: results.stats.health.deduped_counts,
    dedupedTotal: dedupedTotal(results),
    multipleCount: results.stats.health.multiple_count,
  };
}

function dedupedTotal(results) {
  return Object.values(results?.stats?.health?.deduped_counts ?? {}).reduce(
    (sum, value) => sum + Number(value),
    0,
  );
}

function exposureTotal(results) {
  return Object.values(results?.stats?.health?.exposure_counts ?? {}).reduce(
    (sum, value) => sum + Number(value),
    0,
  );
}
