import type { EnvScope } from "@splitch/db";
import type { ControlPlaneApiEnv } from "./env";
import type { RunRow } from "./experiment-model";

export interface RunSnapshotDelivery {
  apiUrl?: string;
  token?: string;
  fetch?: typeof fetch;
  /**
   * Fault sink for a failed ship. The Start response is honestly 200 (the Run
   * committed), so this is the only channel that reaches Sentry (ADR-0047);
   * `console.error` alone is stripped from Sentry by the observability wiring.
   */
  onFault?: (detail: Record<string, unknown>, cause: unknown) => void;
}

export interface RunSnapshotRow {
  app_id: string;
  environment_id: string;
  experiment_id: string;
  run_id: string;
  started_at: string;
  snapshot_at: string;
  confidence_level: number;
  horizon: string;
  target_n: number | null;
  sample_size_locked: number | null;
  allocation: string;
  control_variant: string;
  control_variant_id: string;
  decision_family: string;
  guardrail_decisions: string;
  dimensions: string;
  config_hash: string;
}

export function runSnapshotDeliveryFromEnv(env: ControlPlaneApiEnv): RunSnapshotDelivery {
  return {
    apiUrl: env.TINYBIRD_API_URL,
    token: env.TINYBIRD_RUN_SNAPSHOT_TOKEN,
  };
}

export function runSnapshotRow(run: RunRow, scope: EnvScope, snapshotAt: string): RunSnapshotRow {
  const variants = parseVariantSet(run.variantSet);
  const controlVariant = variants.find((variant) => variant.id === run.controlVariantId);
  if (!controlVariant) {
    throw new Error(
      `Run ${run.id} Control Variant ${run.controlVariantId} is absent from variantSet`,
    );
  }
  return {
    app_id: scope.appId,
    environment_id: scope.environmentId,
    experiment_id: run.experimentId,
    run_id: run.id,
    started_at: run.startedAt,
    snapshot_at: snapshotAt,
    confidence_level: run.confidenceLevel,
    horizon: run.horizon,
    target_n: run.targetN,
    sample_size_locked: run.sampleSizeLocked,
    allocation: run.allocation,
    control_variant: controlVariant.name,
    control_variant_id: run.controlVariantId,
    decision_family: run.decisionFamily,
    guardrail_decisions: run.guardrailDecisions,
    // Dimension config has no backing data until SPL-183 lands.
    dimensions: "[]",
    config_hash: run.configHash,
  };
}

async function shipRunSnapshot(
  delivery: RunSnapshotDelivery | undefined,
  row: RunSnapshotRow,
): Promise<void> {
  if (!delivery?.apiUrl) throw new Error("Tinybird Run Snapshot API URL is unavailable");
  if (!delivery.token) throw new Error("Tinybird Run Snapshot token is unavailable");
  const url = new URL("/v0/events", delivery.apiUrl);
  url.searchParams.set("name", "run_snapshots");
  let response: Response;
  try {
    response = await (delivery.fetch ?? fetch)(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${delivery.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(row),
    });
  } catch (cause) {
    throw new Error("Tinybird Run Snapshot append failed with HTTP status unavailable", { cause });
  }
  if (!response.ok) {
    throw new Error(`Tinybird Run Snapshot append failed with HTTP ${response.status}`);
  }
  // A 2xx can still quarantine the row (schema mismatch), which would report
  // "shipped" for a snapshot the analysis engine can never read. An unparseable
  // body is accepted: the success shape is Tinybird's to define, and the row
  // count is only asserted where Tinybird states it.
  const body = (await response.json().catch(() => null)) as {
    successful_rows?: number;
    quarantined_rows?: number;
  } | null;
  if (body && ((body.quarantined_rows ?? 0) > 0 || body.successful_rows === 0)) {
    throw new Error(
      `Tinybird Run Snapshot append quarantined the row (successful=${body.successful_rows}, quarantined=${body.quarantined_rows})`,
    );
  }
}

export async function shipCommittedRunSnapshot(
  delivery: RunSnapshotDelivery | undefined,
  run: RunRow,
  scope: EnvScope,
  snapshotAt: string,
): Promise<boolean> {
  try {
    await shipRunSnapshot(delivery, runSnapshotRow(run, scope, snapshotAt));
    return true;
  } catch (cause) {
    const detail = {
      appId: scope.appId,
      environmentId: scope.environmentId,
      experimentId: run.experimentId,
      runId: run.id,
      fault: cause instanceof Error ? cause.message : String(cause),
    };
    // Same containment rule as `containObservability`: a throwing fault sink
    // must not corrupt a correct 200 into a 500 on top of the lost report.
    try {
      if (delivery?.onFault) {
        delivery.onFault(detail, cause);
      } else {
        console.error("run-snapshot: Run Snapshot did not ship", detail);
      }
    } catch {
      console.error("run-snapshot: fault sink threw", { runId: run.id });
    }
    return false;
  }
}

function parseVariantSet(raw: string): Array<{ id: string; name: string }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error("Run variantSet is unparseable", { cause });
  }
  if (
    !Array.isArray(parsed) ||
    parsed.some(
      (variant) =>
        !variant ||
        typeof variant !== "object" ||
        typeof (variant as { id?: unknown }).id !== "string" ||
        typeof (variant as { name?: unknown }).name !== "string",
    )
  ) {
    throw new Error("Run variantSet is unparseable");
  }
  return parsed as Array<{ id: string; name: string }>;
}
