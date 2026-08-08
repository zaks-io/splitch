import { appendRawEvent, tinybirdDelivery } from "./tinybird";
import type { Env } from "./types";

type MetricEventRow = Record<string, unknown>;

export async function handleMetricEventQueue(
  batch: MessageBatch<MetricEventRow>,
  env: Env,
): Promise<void> {
  const delivery = tinybirdDelivery(env, "metric_events");
  await Promise.all(
    batch.messages.map(async (message) => {
      try {
        if (!delivery.ok) throw new Error(delivery.error.message);
        await appendRawEvent(message.body, delivery.value);
        message.ack();
      } catch (error) {
        console.error("event-ingest-api Metric Event delivery failed", {
          queueMessageId: message.id,
          attempts: message.attempts,
          ...metricEventIdentity(message.body),
          errorMessage: error instanceof Error ? error.message : "non-error rejection",
        });
        message.retry();
      }
    }),
  );
}

function metricEventIdentity(row: MetricEventRow): Record<string, string> {
  const identity: Record<string, string> = {};
  addString(identity, "appId", row.app_id);
  addString(identity, "environmentId", row.environment_id);
  addString(identity, "eventId", row.event_id);
  addString(identity, "eventDefinitionId", row.event_definition_id);
  return identity;
}

function addString(identity: Record<string, string>, key: string, value: unknown): void {
  if (typeof value === "string") identity[key] = value;
}
