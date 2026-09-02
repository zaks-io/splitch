import { assignmentKey, CURRENT_KV_SCHEMA_VERSION } from "@splitch/contracts";
import {
  METRIC_APP_ID,
  METRIC_ENVIRONMENT_ID,
  type MetricEventFixture,
  metricEventBody,
} from "./metric-event.test-fixture";
import { resolveMetricEventIdentityMaterial } from "./metric-event-identity";

export async function seedMetricEventAssignment(
  fixture: MetricEventFixture,
  input: {
    experimentId: string;
    runId: string;
    variant: string;
    identityEpoch?: "current" | "oldest";
  },
): Promise<string> {
  const event = metricEventBody();
  const identity = await resolveMetricEventIdentityMaterial(
    fixture.env,
    {
      appId: METRIC_APP_ID,
      environmentId: METRIC_ENVIRONMENT_ID,
      credentialHash: fixture.hash,
      credentialKind: fixture.credentialKind,
      rateLimitRps: null,
    },
    event,
  );
  const targetingKeyHash =
    input.identityEpoch === "oldest"
      ? identity.identity.targetingKeyHashes[0]
      : identity.targetingKeyHash;
  if (!targetingKeyHash) throw new Error("Metric Event identity has no retained hash");
  fixture.assignments.set(
    assignmentKey(METRIC_APP_ID, event.idType, targetingKeyHash),
    JSON.stringify({
      schemaVersion: CURRENT_KV_SCHEMA_VERSION,
      data: {
        [input.experimentId]: { runId: input.runId, variant: input.variant },
      },
    }),
  );
  return targetingKeyHash;
}
