import { beforeAll, describe, expect, it, vi } from "vitest";
import type { EntityPrivacyConsumer } from "./entity-privacy-consumer";
import {
  assertPageBound,
  PRIVACY_EXPORT_PAGE_MAX_BYTES,
  PRIVACY_EXPORT_PAGE_SIZE,
  PRIVACY_EXPORT_PROOF_MAX,
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

beforeAll(() => {
  if (typeof DigestStream !== "undefined") return;
  Object.defineProperty(globalThis, "DigestStream", { value: TestDigestStream });
});

describe("Entity privacy export artifact", () => {
  it("streams bounded pages into private R2 and hashes the exact artifact", async () => {
    const calls: Array<{ store: string; cursor: string | null; limit: number }> = [];
    const stored: { key?: string; body?: Uint8Array } = {};
    const consumer = consumerWithPages(calls);
    const renewLease = vi.fn(async () => undefined);
    const result = await writeEntityPrivacyExport({
      bucket: {
        async put(key: string, value: ReadableStream) {
          stored.key = key;
          stored.body = new Uint8Array(await new Response(value).arrayBuffer());
          return {} as R2Object;
        },
      } as R2Bucket,
      consumer,
      entity,
      requestId: entity.requestId,
      expiresAt: "2026-07-19T12:00:00.000Z",
      renewLease,
    });

    expect(stored.key).toBe(`privacy-exports/${entity.appId}/${entity.requestId}.json`);
    const artifact = JSON.parse(new TextDecoder().decode(stored.body));
    expect(artifact).toMatchObject({
      schemaVersion: "entity-privacy-export-v1",
      appId: entity.appId,
      stores: [
        { name: "assignments", records: [{ page: 1 }, { page: 2 }] },
        { name: "analysis", records: [{ store: "analysis" }] },
        { name: "event-ingest", records: [] },
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

  it("rejects unbounded proof accumulation", async () => {
    const consumer = consumerWithPages([]);
    consumer.exportAssignmentsPage = async () =>
      page([], null, Array(PRIVACY_EXPORT_PROOF_MAX + 1).fill("proof"));
    await expect(
      writeEntityPrivacyExport({
        bucket: {
          async put(_key: string, value: ReadableStream) {
            await value.cancel();
            return {} as R2Object;
          },
        } as R2Bucket,
        consumer,
        entity,
        requestId: entity.requestId,
        expiresAt: "2026-07-19T12:00:00.000Z",
        renewLease: async () => undefined,
      }),
    ).rejects.toThrow("proof limit");
  });
});

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

class TestDigestStream extends WritableStream<Uint8Array> {
  readonly digest: Promise<ArrayBuffer>;
  constructor() {
    const chunks: Uint8Array[] = [];
    let resolveDigest: (value: ArrayBuffer) => void = () => undefined;
    const digest = new Promise<ArrayBuffer>((resolve) => {
      resolveDigest = resolve;
    });
    super({
      write: (chunk) => {
        chunks.push(chunk.slice());
      },
      close: async () => {
        const length = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
        const bytes = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        resolveDigest(await crypto.subtle.digest("SHA-256", bytes));
      },
    });
    this.digest = digest;
  }
}
