import { describe, expect, it, vi } from "vitest";
import type { EntityPrivacyConsumer } from "./entity-privacy-consumer";
import {
  assertPageBound,
  PRIVACY_EXPORT_PAGE_MAX_BYTES,
  PRIVACY_EXPORT_PAGE_SIZE,
  writeEntityPrivacyExport,
} from "./entity-privacy-export-artifact";
import type { EntityPrivacyExportPage } from "./entity-privacy-service-client";

const entity = {
  appId: "app_privacy_export",
  idType: "user",
  targetingKeyHashes: ["app-v1:subject"],
  entityFamilyHash: "app-v1:subject",
  actorId: "user_admin",
  orgId: "org_privacy_export",
  requestId: "prv_export",
};

describe("Entity privacy export artifact", () => {
  it("streams bounded pages into private R2 and hashes the exact artifact", async () => {
    const calls: Array<{ store: string; cursor: string | null; limit: number }> = [];
    const stored: { key?: string; body?: Uint8Array } = {};
    const consumer = consumerWithPages(calls);
    const renewLease = vi.fn(async () => undefined);
    const result = await writeEntityPrivacyExport({
      bucket: multipartBucket(stored),
      consumer,
      entity,
      requestId: entity.requestId,
      artifactKey: `privacy-exports/${entity.appId}/${entity.requestId}/attempt.json`,
      expiresAt: "2026-07-19T12:00:00.000Z",
      renewLease,
    });

    expect(stored.key).toBe(`privacy-exports/${entity.appId}/${entity.requestId}/attempt.json`);
    const artifact = JSON.parse(new TextDecoder().decode(stored.body));
    expect(artifact).toMatchObject({
      schemaVersion: "entity-privacy-export-v1",
      appId: entity.appId,
      stores: [
        {
          name: "assignments",
          pages: [{ records: [{ page: 1 }] }, { records: [{ page: 2 }] }],
        },
        { name: "analysis", pages: [{ records: [{ store: "analysis" }] }] },
        { name: "event-ingest", pages: [{ records: [] }] },
      ],
    });
    expect(calls).toEqual([
      { store: "assignments", cursor: null, limit: PRIVACY_EXPORT_PAGE_SIZE },
      { store: "assignments", cursor: "assignment-next", limit: PRIVACY_EXPORT_PAGE_SIZE },
      { store: "analysis", cursor: null, limit: PRIVACY_EXPORT_PAGE_SIZE },
      { store: "event-ingest", cursor: null, limit: PRIVACY_EXPORT_PAGE_SIZE },
    ]);
    expect(renewLease).toHaveBeenCalledTimes(calls.length);
    const expectedDigest = await crypto.subtle.digest(
      "SHA-256",
      stored.body as Uint8Array<ArrayBuffer>,
    );
    expect(result.artifactSha256).toBe(`sha256:${toHex(expectedDigest)}`);
  });

  it("rejects a store page over either bound", () => {
    expect(() => assertPageBound(page(Array(PRIVACY_EXPORT_PAGE_SIZE + 1).fill({})))).toThrow(
      "record limit",
    );
    expect(() =>
      assertPageBound(page([{ value: "x".repeat(PRIVACY_EXPORT_PAGE_MAX_BYTES) }])),
    ).toThrow("byte limit");
  });

  it("streams proofs without imposing a total record ceiling", async () => {
    const stored: { key?: string; body?: Uint8Array } = {};
    const consumer = consumerWithPages([]);
    consumer.exportAssignmentsPage = async () => page([], null, Array(1_001).fill("proof"));
    await writeEntityPrivacyExport({
      bucket: multipartBucket(stored),
      consumer,
      entity,
      requestId: entity.requestId,
      artifactKey: `privacy-exports/${entity.appId}/${entity.requestId}/proofs.json`,
      expiresAt: "2026-07-19T12:00:00.000Z",
      renewLease: async () => undefined,
    });
    const artifact = JSON.parse(new TextDecoder().decode(stored.body));
    expect(artifact.stores[0].pages[0].proofs).toHaveLength(1_001);
  });
});

function multipartBucket(stored: { key?: string; body?: Uint8Array }): R2Bucket {
  return {
    async createMultipartUpload(key: string) {
      stored.key = key;
      const parts = new Map<number, Uint8Array>();
      return {
        key,
        uploadId: "test-upload",
        async uploadPart(partNumber: number, value: ArrayBufferView) {
          parts.set(
            partNumber,
            new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice(),
          );
          return { partNumber, etag: `part-${String(partNumber)}` };
        },
        async complete(uploaded: R2UploadedPart[]) {
          const bytes = uploaded.map((part) => parts.get(part.partNumber) as Uint8Array);
          stored.body = concat(bytes);
          return {} as R2Object;
        },
        async abort() {},
      } as R2MultipartUpload;
    },
  } as R2Bucket;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function consumerWithPages(
  calls: Array<{ store: string; cursor: string | null; limit: number }>,
): EntityPrivacyConsumer {
  return {
    async exportAssignmentsPage(_input, cursor, limit) {
      calls.push({ store: "assignments", cursor, limit });
      return cursor === null
        ? page([{ page: 1 }], "assignment-next", ["assignment:page=1"])
        : page([{ page: 2 }], null, ["assignment:page=2"]);
    },
    async exportAnalysisPage(_input, cursor, limit) {
      calls.push({ store: "analysis", cursor, limit });
      return page([{ store: "analysis" }], null, ["tinybird:rows=1"]);
    },
    async exportEventsPage(_input, cursor, limit) {
      calls.push({ store: "event-ingest", cursor, limit });
      return page([], null, ["event-ingest:rows=0"]);
    },
    async resolveIdentity() {
      throw new Error("not used");
    },
    async exportEntity() {
      throw new Error("not used");
    },
    async suppressAnalysis() {
      throw new Error("not used");
    },
    async suppressEvents() {
      throw new Error("not used");
    },
    async deleteAssignments() {
      throw new Error("not used");
    },
    async deleteAnalysis() {
      throw new Error("not used");
    },
    async deleteEvents() {
      throw new Error("not used");
    },
  };
}

function page(
  records: readonly unknown[],
  nextCursor: string | null = null,
  proofs: readonly string[] = [],
): EntityPrivacyExportPage {
  return { ...entity, records, nextCursor, proofs };
}

function toHex(value: ArrayBuffer): string {
  return [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
