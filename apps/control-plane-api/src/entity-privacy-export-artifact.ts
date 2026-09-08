import { sha256 } from "@noble/hashes/sha2.js";
import type { EntityPrivacyConsumer } from "./entity-privacy-consumer";
import type {
  EntityPrivacyExportPage,
  ResolvedEntityPrivacyInput,
} from "./entity-privacy-service-client";

export const PRIVACY_EXPORT_PAGE_SIZE = 100;
export const PRIVACY_EXPORT_PAGE_MAX_BYTES = 1_000_000;
export const PRIVACY_EXPORT_RETENTION_MS = 24 * 60 * 60 * 1000;
export const PRIVACY_EXPORT_DOWNLOAD_TTL_MS = 15 * 60 * 1000;
const PRIVACY_EXPORT_MULTIPART_PART_BYTES = 5 * 1024 * 1024;
const PRIVACY_EXPORT_MULTIPART_MAX_PARTS = 10_000;

const encoder = new TextEncoder();
const stores = [
  ["assignments", "exportAssignmentsPage"],
  ["analysis", "exportAnalysisPage"],
  ["event-ingest", "exportEventsPage"],
] as const;

export async function writeEntityPrivacyExport(input: {
  bucket: R2Bucket;
  consumer: EntityPrivacyConsumer;
  entity: ResolvedEntityPrivacyInput;
  requestId: string;
  expiresAt: string;
  artifactKey: string;
  renewLease: () => Promise<void>;
}): Promise<{ artifactKey: string; artifactSha256: string }> {
  const upload = await input.bucket.createMultipartUpload(input.artifactKey, {
    httpMetadata: {
      contentType: "application/json",
      contentDisposition: `attachment; filename="${input.requestId}.json"`,
    },
    customMetadata: { requestId: input.requestId, expiresAt: input.expiresAt },
  });
  const writer = new MultipartArtifactWriter(upload);

  try {
    await writeJson(writer, artifactHeader(input.entity));
    for (let index = 0; index < stores.length; index += 1) {
      if (index > 0) await writeJson(writer, ",");
      const [name, method] = stores[index] as (typeof stores)[number];
      await writeStore(
        writer,
        name,
        (cursor) => input.consumer[method](input.entity, cursor, PRIVACY_EXPORT_PAGE_SIZE),
        input.renewLease,
      );
    }
    await writeJson(writer, "]}");
    const digestBytes = await writer.close();
    return {
      artifactKey: input.artifactKey,
      artifactSha256: `sha256:${toHex(digestBytes)}`,
    };
  } catch (cause) {
    await writer.abort(cause).catch(() => undefined);
    throw cause;
  }
}

function artifactHeader(entity: ResolvedEntityPrivacyInput): string {
  return `${JSON.stringify({
    schemaVersion: "entity-privacy-export-v1",
    appId: entity.appId,
    idType: entity.idType,
    targetingKeyHashes: entity.targetingKeyHashes,
    entityFamilyHash: entity.entityFamilyHash,
  }).slice(0, -1)},"stores":[`;
}

async function writeStore(
  writer: MultipartArtifactWriter,
  name: (typeof stores)[number][0],
  readPage: (cursor: string | null) => Promise<EntityPrivacyExportPage>,
  renewLease: () => Promise<void>,
): Promise<void> {
  await writeJson(writer, `{"name":${JSON.stringify(name)},"pages":[`);
  let cursor: string | null = null;
  let firstPage = true;
  do {
    await renewLease();
    const page = await readPage(cursor);
    assertPageBound(page);
    if (!firstPage) await writeJson(writer, ",");
    await writeJson(writer, JSON.stringify({ records: page.records, proofs: page.proofs }));
    firstPage = false;
    if (page.nextCursor !== null && page.nextCursor === cursor) {
      throw new Error(`Entity privacy ${name} export cursor did not advance`);
    }
    cursor = page.nextCursor;
  } while (cursor !== null);
  await writeJson(writer, "]}");
}

export function assertPageBound(page: EntityPrivacyExportPage): void {
  if (page.records.length > PRIVACY_EXPORT_PAGE_SIZE) {
    throw new Error("Entity privacy export page exceeded the record limit");
  }
  const bytes = encoder.encode(JSON.stringify(page.records)).byteLength;
  if (bytes > PRIVACY_EXPORT_PAGE_MAX_BYTES) {
    throw new Error("Entity privacy export page exceeded the byte limit");
  }
}

function writeJson(writer: MultipartArtifactWriter, value: string): Promise<void> {
  return writer.write(encoder.encode(value));
}

class MultipartArtifactWriter {
  private readonly digest = sha256.create();
  private readonly pending: Uint8Array[] = [];
  private pendingBytes = 0;
  private readonly uploadedParts: R2UploadedPart[] = [];

  constructor(private readonly upload: R2MultipartUpload) {}

  async write(value: Uint8Array): Promise<void> {
    this.digest.update(value);
    this.pending.push(value);
    this.pendingBytes += value.byteLength;
    while (this.pendingBytes >= PRIVACY_EXPORT_MULTIPART_PART_BYTES) {
      await this.flush(PRIVACY_EXPORT_MULTIPART_PART_BYTES);
    }
  }

  async close(): Promise<Uint8Array> {
    if (this.pendingBytes > 0) await this.flush(this.pendingBytes);
    await this.upload.complete(this.uploadedParts);
    return this.digest.digest();
  }

  async abort(_cause: unknown): Promise<void> {
    await this.upload.abort();
  }

  private async flush(size: number): Promise<void> {
    if (this.uploadedParts.length >= PRIVACY_EXPORT_MULTIPART_MAX_PARTS) {
      throw new Error("Entity privacy export exceeded the multipart part limit");
    }
    const bytes = this.take(size);
    const partNumber = this.uploadedParts.length + 1;
    this.uploadedParts.push(await this.upload.uploadPart(partNumber, bytes));
  }

  private take(size: number): Uint8Array {
    const result = new Uint8Array(size);
    let offset = 0;
    while (offset < size) {
      const chunk = this.pending.shift();
      if (!chunk) throw new Error("Entity privacy multipart buffer underflow");
      const remaining = size - offset;
      const consumed = Math.min(remaining, chunk.byteLength);
      result.set(chunk.subarray(0, consumed), offset);
      offset += consumed;
      if (consumed < chunk.byteLength) this.pending.unshift(chunk.subarray(consumed));
    }
    this.pendingBytes -= size;
    return result;
  }
}

function toHex(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
