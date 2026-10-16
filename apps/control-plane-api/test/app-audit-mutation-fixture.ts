import { type AuditEventRow, appScope, type Repository } from "@splitch/db";
import type { Hono } from "hono";
import { expect } from "vitest";

export const CANARIES = {
  secret: "CANARY_PRIVATE_SECRET_MATERIAL",
  context: "CANARY_PRIVATE_CONTEXT_VALUE",
  targetingKey: "CANARY_RAW_TARGETING_KEY",
  reason: "CANARY_PRIVATE_REASON",
};

export function auditRows(repo: Repository, appId: string): Promise<AuditEventRow[]> {
  return repo.auditEvents.list(appScope(appId));
}

export async function auditRequest(input: {
  app: Hono;
  jwt: string;
  path: string;
  requestId: string;
  body: Record<string, unknown>;
  method?: string;
  idempotencyKey?: string;
}) {
  return input.app.request(input.path, {
    method: input.method ?? "POST",
    headers: {
      authorization: `Bearer ${input.jwt}`,
      "content-type": "application/json",
      "x-request-id": input.requestId,
      ...(input.idempotencyKey ? { "idempotency-key": input.idempotencyKey } : {}),
    },
    body: JSON.stringify(input.body),
  });
}

export function expectPrivateAudit(rows: AuditEventRow[], jwt: string) {
  const serialized = JSON.stringify(rows);
  for (const value of [...Object.values(CANARIES), jwt]) {
    expect(serialized.includes(value), "audit must exclude private caller values").toBe(false);
  }
  expect(new Set(rows.map((row) => row.eventId)).size).toBe(rows.length);
  for (const row of rows) {
    expect(row.eventId).toEqual(expect.any(String));
    expect(row.organizationId).toEqual(expect.any(String));
    expect(row.changedAt).toEqual(expect.any(String));
    expect(row.forwardedAt).toBeNull();
  }
}
