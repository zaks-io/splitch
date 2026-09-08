import { env } from "cloudflare:test";
import { expect, it } from "vitest";
import type { EntityPrivacyConsumer } from "../src/entity-privacy-consumer";
import { writeEntityPrivacyExport } from "../src/entity-privacy-export-artifact";
import type { EntityPrivacyExportPage } from "../src/entity-privacy-service-client";

it("writes an Entity privacy export through the real R2 binding", async () => {
  const requestId = `prv_r2_${crypto.randomUUID()}`;
  const artifactKey = `privacy-exports/app_r2/${requestId}/attempt.json`;
  const entity = {
    appId: "app_r2",
    idType: "user",
    targetingKeyHashes: ["app-v1:subject"],
    entityFamilyHash: "app-v1:subject",
    actorId: "user_r2",
    orgId: "org_r2",
    requestId,
  };
  const page = (records: readonly unknown[]): EntityPrivacyExportPage => ({
    ...entity,
    records,
    proofs: ["complete"],
    nextCursor: null,
  });
  const consumer = {
    exportAssignmentsPage: async () => page([{ assignment: true }]),
    exportAnalysisPage: async () => page([{ event: true }]),
    exportEventsPage: async () => page([]),
  } as unknown as EntityPrivacyConsumer;

  try {
    const result = await writeEntityPrivacyExport({
      bucket: env.PRIVACY_EXPORTS,
      consumer,
      entity,
      requestId,
      artifactKey,
      expiresAt: "2026-07-19T12:00:00.000Z",
      renewLease: async () => undefined,
    });
    expect(result.artifactKey).toBe(artifactKey);
    const stored = await env.PRIVACY_EXPORTS.get(artifactKey);
    expect(stored).not.toBeNull();
    expect(await stored?.json()).toMatchObject({
      schemaVersion: "entity-privacy-export-v1",
      stores: [{ name: "assignments" }, { name: "analysis" }, { name: "event-ingest" }],
    });
  } finally {
    await env.PRIVACY_EXPORTS.delete(artifactKey);
  }
});
