import { readFileSync } from "node:fs";
import { join } from "node:path";

const RETAINED_FAMILY_PROJECTION =
  "if(startsWith(targeting_key_hash, 'local-v1:'), concat('v1:', substring(targeting_key_hash, 10)), targeting_key_hash) AS entity_family_hash";
const EXPECTED_FORWARD_QUERIES = {
  raw_events: `SELECT dedup_key, app_id, environment_id, experiment_id, run_id, id_type, targeting_key_hash, ${RETAINED_FAMILY_PROJECTION}, variant, type, event_id, counterfactual, source_id, client_timestamp, server_received_at, exposure_at, ingest_ts, activation_ts, is_holdover, sdk_version`,
  deduped_exposures: `SELECT app_id, environment_id, experiment_id, run_id, id_type, targeting_key_hash, ${RETAINED_FAMILY_PROJECTION}, variant, first_exposure_ts, snapshot_ts, watermark_ts`,
  metric_events: `SELECT dedup_key, event_id, app_id, environment_id, event_definition_id, event_definition_version_id, event_name, id_type, targeting_key_hash, ${RETAINED_FAMILY_PROJECTION}, fields, dimensions, server_received_at, ingest_ts`,
};

export function assertRetainedFamilyMigrationContract(root, fail) {
  for (const [name, expected] of Object.entries(EXPECTED_FORWARD_QUERIES)) {
    const contents = readFileSync(join(root, "datasources", `${name}.datasource`), "utf8");
    const marker = "FORWARD_QUERY >\n";
    const markerIndex = contents.indexOf(marker);
    const hasOneQuery = markerIndex >= 0 && markerIndex === contents.lastIndexOf(marker);
    const actual = hasOneQuery ? contents.slice(markerIndex + marker.length).trim() : null;
    if (actual !== expected) {
      fail(`${name} must carry its exact one-release retained-family migration`);
    }
  }
}
