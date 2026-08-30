import { requirePlatformTarget } from "@splitch/contracts";
import type { MetricEventDeliveryAttempt } from "./metric-event-delivery-attempt";
import { settleMetricEventDelivery } from "./metric-event-delivery-attempt";
import { queueRetryDelaySeconds } from "./queue-retry";
import type { Env } from "./types";

const RECONCILIATION_KIND = "metric-event-reconciliation-v1";
const PIPE_NAME = "reconcile_metric_event_delivery";
const POPULATE_PIPE_NAME = "populate_metric_event_delivery_state";
const READ_TIMEOUT_MS = 15_000;

export interface UnresolvedMetricEvent {
  readonly message: Message<Record<string, unknown>>;
  readonly dedupKey: string;
  readonly attempt: MetricEventDeliveryAttempt;
  readonly reason: string;
}

interface ReconciliationEnvelope extends Record<string, unknown> {
  readonly kind: typeof RECONCILIATION_KIND;
  readonly dedupKey: string;
  readonly attempt: MetricEventDeliveryAttempt;
  readonly appId: string;
  readonly environmentId: string;
  readonly eventDefinitionId: string;
  readonly serverReceivedAt: string;
}

/** Acknowledge the primary message only after its recovery work is durable. */
export async function transferToReconciliation(
  unresolved: readonly UnresolvedMetricEvent[],
  env: Env,
): Promise<void> {
  if (unresolved.length === 0) return;
  const queue = env.METRIC_EVENTS_RECONCILIATION_QUEUE;
  if (!queue) throw new Error("METRIC_EVENTS_RECONCILIATION_QUEUE binding is unavailable");
  await queue.sendBatch(unresolved.map((entry) => ({ body: reconciliationEnvelope(entry) })));
  for (const entry of unresolved) entry.message.ack();
}

export async function handleMetricEventReconciliationQueue(
  batch: MessageBatch<Record<string, unknown>>,
  env: Env,
): Promise<void> {
  requirePlatformTarget(env.SPLITCH_PLATFORM_TARGET);
  for (const message of batch.messages) {
    try {
      const envelope = parseReconciliationEnvelope(message.body);
      if (await metricEventCommitted(envelope, env)) {
        await settleMetricEventDelivery(env.METRIC_EVENT_OUTBOX, envelope.dedupKey, {
          ...envelope.attempt,
          state: "delivered",
          reason: undefined,
        });
        message.ack();
        continue;
      }
      message.retry({
        delaySeconds: queueRetryDelaySeconds(message.attempts, message.id),
      });
    } catch (error) {
      console.error("event-ingest-api Metric Event reconciliation failed", {
        queueMessageId: message.id,
        attempts: message.attempts,
        errorMessage: error instanceof Error ? error.message : "non-error rejection",
      });
      message.retry({
        delaySeconds: queueRetryDelaySeconds(message.attempts, message.id),
      });
    }
  }
}

async function metricEventCommitted(envelope: ReconciliationEnvelope, env: Env): Promise<boolean> {
  let evidence = await readEvidence(envelope, env);
  if (evidence.rawRows > 0 && evidence.stateRows === 0) {
    await populateState(envelope, env);
    evidence = await readEvidence(envelope, env);
  }
  if (evidence.rawRows > 0 && evidence.stateRows > 0) return true;
  if (evidence.rawRows === 0 && evidence.stateRows === 0) return false;
  throw new Error(
    `Tinybird reconciliation returned mixed evidence raw=${String(evidence.rawRows)} state=${String(evidence.stateRows)}`,
  );
}

interface ReconciliationEvidence {
  readonly rawRows: number;
  readonly stateRows: number;
}

async function readEvidence(
  envelope: ReconciliationEnvelope,
  env: Env,
): Promise<ReconciliationEvidence> {
  if (!env.TINYBIRD_READ_TOKEN) throw new Error("TINYBIRD_READ_TOKEN is unavailable");
  const url = pipeUrl(env, PIPE_NAME, envelope);
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${env.TINYBIRD_READ_TOKEN}` },
    signal: AbortSignal.timeout(READ_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Tinybird reconciliation returned HTTP ${response.status}`);
  const body = (await response.json()) as { data?: unknown };
  if (!Array.isArray(body.data) || body.data.length !== 1 || !isRecord(body.data[0])) {
    throw new Error("Tinybird reconciliation returned a malformed result");
  }
  const rawRows = body.data[0].raw_rows;
  const stateRows = body.data[0].state_rows;
  if (
    typeof rawRows !== "number" ||
    !Number.isInteger(rawRows) ||
    rawRows < 0 ||
    typeof stateRows !== "number" ||
    !Number.isInteger(stateRows) ||
    stateRows < 0
  ) {
    throw new Error("Tinybird reconciliation returned invalid row counts");
  }
  return { rawRows, stateRows };
}

async function populateState(envelope: ReconciliationEnvelope, env: Env): Promise<void> {
  if (!env.TINYBIRD_COPY_TOKEN) throw new Error("TINYBIRD_COPY_TOKEN is unavailable");
  const response = await fetch(pipeUrl(env, POPULATE_PIPE_NAME, envelope, "/copy"), {
    method: "POST",
    headers: { authorization: `Bearer ${env.TINYBIRD_COPY_TOKEN}` },
    signal: AbortSignal.timeout(READ_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Tinybird state populate returned HTTP ${response.status}`);
}

function pipeUrl(
  env: Env,
  pipeName: string,
  envelope: ReconciliationEnvelope,
  suffix = ".json",
): URL {
  if (!env.TINYBIRD_API_URL) throw new Error("TINYBIRD_API_URL is unavailable");
  const url = new URL(`/v0/pipes/${pipeName}${suffix}`, env.TINYBIRD_API_URL);
  url.searchParams.set("app_id", envelope.appId);
  url.searchParams.set("environment_id", envelope.environmentId);
  url.searchParams.set("event_definition_id", envelope.eventDefinitionId);
  url.searchParams.set("dedup_key", envelope.dedupKey);
  url.searchParams.set("server_received_at", tinybirdDateTime64(envelope.serverReceivedAt));
  return url;
}

function tinybirdDateTime64(isoUtc: string): string {
  const ms = Date.parse(isoUtc);
  if (!Number.isFinite(ms)) throw new Error(`Metric Event reconciliation timestamp is invalid`);
  return new Date(ms).toISOString().replace("T", " ").replace("Z", "");
}

function reconciliationEnvelope(entry: UnresolvedMetricEvent): ReconciliationEnvelope {
  const row = entry.message.body;
  return {
    kind: RECONCILIATION_KIND,
    dedupKey: entry.dedupKey,
    attempt: entry.attempt,
    appId: requiredString(row, "app_id"),
    environmentId: requiredString(row, "environment_id"),
    eventDefinitionId: requiredString(row, "event_definition_id"),
    serverReceivedAt: requiredString(row, "server_received_at"),
  };
}

function parseReconciliationEnvelope(value: Record<string, unknown>): ReconciliationEnvelope {
  if (
    value.kind !== RECONCILIATION_KIND ||
    !isRecord(value.attempt) ||
    typeof value.attempt.attemptId !== "string" ||
    typeof value.attempt.state !== "string" ||
    typeof value.attempt.attempts !== "number"
  ) {
    throw new Error("Metric Event reconciliation envelope is invalid");
  }
  for (const field of [
    "dedupKey",
    "appId",
    "environmentId",
    "eventDefinitionId",
    "serverReceivedAt",
  ]) {
    requiredString(value, field);
  }
  return value as ReconciliationEnvelope;
}

function requiredString(value: Record<string, unknown>, field: string): string {
  const candidate = value[field];
  if (typeof candidate !== "string" || candidate.length === 0) {
    throw new Error(`Metric Event reconciliation has no ${field}`);
  }
  return candidate;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
