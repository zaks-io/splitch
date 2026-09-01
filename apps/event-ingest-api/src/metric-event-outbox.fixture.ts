import { expect, vi } from "vitest";
import type { MetricEventDeliveryAttempt } from "./metric-event-delivery-attempt";
import { MetricEventOutboxDurableObject } from "./metric-event-outbox";
import type { Env } from "./types";

const STATE_KEY = "metric-event-claim";
const DEDUP_URL = "https://metric-event-outbox.local/claim";

export interface ClaimInput {
  readonly fingerprint: string;
  readonly eventDefinitionId: string;
  readonly eventDefinitionVersionId: string;
  readonly row: Record<string, unknown>;
}

export function row(
  targetingKey: string,
  serverReceivedAt = "2026-08-07T00:00:00.000Z",
): ClaimInput {
  return {
    fingerprint: `fp_${targetingKey}`,
    eventDefinitionId: "ed_signed_up",
    eventDefinitionVersionId: "edv_1",
    row: {
      event_name: "signed_up",
      targeting_key_hash: targetingKey,
      server_received_at: serverReceivedAt,
    },
  };
}

/** Durable Object storage round-trips through structured clone, so this does too. */
export function makeOutbox(sendImpl: () => Promise<void> = async () => {}) {
  const storage = new Map<string, unknown>();
  let alarmTime: number | null = null;
  let sendFailure: Error | undefined;
  const send = vi.fn(async (_row: Record<string, unknown>) => {
    if (sendFailure) {
      const error = sendFailure;
      sendFailure = undefined;
      throw error;
    }
    return sendImpl();
  });
  const ctx = {
    storage: {
      async get<T>(key: string) {
        return storage.has(key) ? (structuredClone(storage.get(key)) as T) : undefined;
      },
      async put(key: string, value: unknown) {
        storage.set(key, structuredClone(value));
      },
      async delete(key: string) {
        return storage.delete(key);
      },
      async setAlarm(time: number | Date) {
        alarmTime = typeof time === "number" ? time : time.getTime();
      },
    },
  } as unknown as DurableObjectState;
  const env = { METRIC_EVENTS_QUEUE: { send } } as unknown as Env;
  const object = new MetricEventOutboxDurableObject(ctx, env);

  return {
    send,
    alarmTime: () => alarmTime,
    failNextSend() {
      sendFailure = new Error("queue unavailable");
      return this;
    },
    async runAlarm() {
      alarmTime = null;
      await object.alarm();
    },
    seed(
      state: ClaimInput & {
        queued: boolean;
        delivery?: MetricEventDeliveryAttempt;
        expiresAt?: number;
      },
    ) {
      storage.set(STATE_KEY, structuredClone(state));
    },
    stored() {
      return storage.get(STATE_KEY) as
        | (ClaimInput & {
            queued: boolean;
            expiresAt?: number;
            publishing?: boolean;
            publicationAttempts?: number;
            delivery?: MetricEventDeliveryAttempt;
          })
        | undefined;
    },
    async beginDelivery(attemptId: string) {
      const response = await object.fetch(
        new Request("https://metric-event-outbox.local/begin-delivery", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ attemptId }),
        }),
      );
      expect(response.status).toBe(200);
      return response.json();
    },
    async claim(input: ClaimInput) {
      const response = await object.fetch(
        new Request(DEDUP_URL, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...input, queued: false }),
        }),
      );
      expect(response.status).toBe(200);
      return (await response.json()) as { outcome: string };
    },
    lookup() {
      return object.fetch(
        new Request("https://metric-event-outbox.local/lookup", { method: "GET" }),
      );
    },
    delivery() {
      return object.fetch(
        new Request("https://metric-event-outbox.local/delivery", { method: "GET" }),
      );
    },
    async suppress(input: ClaimInput) {
      const response = await this.suppressResponse(input);
      expect(response.status).toBe(200);
      return response.json();
    },
    suppressResponse(input: ClaimInput) {
      return object.fetch(
        new Request("https://metric-event-outbox.local/suppress", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ...input,
            serverReceivedAt: input.row.server_received_at,
          }),
        }),
      );
    },
    async retain(serverReceivedAt: string) {
      const response = await object.fetch(
        new Request("https://metric-event-outbox.local/retain", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ serverReceivedAt }),
        }),
      );
      expect(response.status).toBe(200);
      return response.json();
    },
    async exported() {
      const response = await object.fetch(new Request("https://metric-event-outbox.local/export"));
      expect(response.status).toBe(200);
      return response.json();
    },
  };
}
