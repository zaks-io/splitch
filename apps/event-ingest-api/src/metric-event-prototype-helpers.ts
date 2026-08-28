import { ErrorResponseSchema, eventDefinitionConfigKey } from "@splitch/contracts";
import { expect } from "vitest";
import {
  hotConfig,
  METRIC_APP_ID,
  METRIC_EVENT_NAME,
  makeMetricEventFixture,
  metricEventBody,
  sendMetricEvent,
} from "./metric-event.test-fixture";

export const PROTOTYPE_NAMES = ["constructor", "toString", "__proto__"] as const;

export function ownJson(key: string, value: unknown): Record<string, unknown> {
  return JSON.parse(`{${JSON.stringify(key)}:${JSON.stringify(value)}}`) as Record<string, unknown>;
}

export const EMPTY_DECLARATION = { fields: [], dimensions: [] };

export async function ingestPrototypeMetricEvent(
  version: Record<string, unknown>,
  body: Record<string, unknown>,
  credentialKind: "api_key" | "client_key" = "api_key",
) {
  const fixture = await makeMetricEventFixture({}, credentialKind);
  fixture.config.set(
    eventDefinitionConfigKey(METRIC_APP_ID, METRIC_EVENT_NAME),
    hotConfig("edv_1", 1, version),
  );
  const response = await sendMetricEvent(fixture, metricEventBody(body));
  const parsed = ErrorResponseSchema.parse(await response.json());
  return { response, parsed };
}

export function mismatchIssues(body: ReturnType<typeof ErrorResponseSchema.parse>) {
  expect(body.code).toBe("EVENT_SCHEMA_MISMATCH");
  if (body.code !== "EVENT_SCHEMA_MISMATCH") throw new Error("expected EVENT_SCHEMA_MISMATCH");
  return body.details.issues;
}

export function expectNoDefinitionIds(body: unknown): void {
  const serialized = JSON.stringify(body);
  expect(serialized).not.toContain("ed_signed_up");
  expect(serialized).not.toContain("edv_1");
}
