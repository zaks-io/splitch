import type { EntityPrivacyConsumer } from "./entity-privacy-consumer";
import type {
  EntityPrivacyExportPage,
  ResolvedEntityPrivacyInput,
} from "./entity-privacy-service-client";

export const PRIVACY_EXPORT_PAGE_SIZE = 100;
export const PRIVACY_EXPORT_PAGE_MAX_BYTES = 1_000_000;
export const PRIVACY_EXPORT_PROOF_MAX = 1_000;
export const PRIVACY_EXPORT_RETENTION_MS = 24 * 60 * 60 * 1000;
export const PRIVACY_EXPORT_DOWNLOAD_TTL_MS = 15 * 60 * 1000;

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
  renewLease: () => Promise<void>;
}): Promise<{ artifactKey: string; artifactSha256: string }> {
  const artifactKey = `privacy-exports/${input.entity.appId}/${input.requestId}.json`;
  const stream = new TransformStream<Uint8Array, Uint8Array>();
  const [objectBody, digestBody] = stream.readable.tee();
  const digest = new DigestStream("SHA-256");
  const digestPromise = digestBody.pipeTo(digest).then(() => digest.digest);
  const putPromise = input.bucket.put(artifactKey, objectBody, {
    httpMetadata: {
      contentType: "application/json",
      contentDisposition: `attachment; filename="${input.requestId}.json"`,
    },
    customMetadata: { requestId: input.requestId, expiresAt: input.expiresAt },
  });
  const writer = stream.writable.getWriter();

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
    await writer.close();
    const [, digestBytes] = await Promise.all([putPromise, digestPromise]);
    return { artifactKey, artifactSha256: `sha256:${toHex(digestBytes)}` };
  } catch (cause) {
    await writer.abort(cause).catch(() => undefined);
    await Promise.all([putPromise.catch(() => undefined), digestPromise.catch(() => undefined)]);
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
  writer: WritableStreamDefaultWriter<Uint8Array>,
  name: (typeof stores)[number][0],
  readPage: (cursor: string | null) => Promise<EntityPrivacyExportPage>,
  renewLease: () => Promise<void>,
): Promise<void> {
  await writeJson(writer, `{"name":${JSON.stringify(name)},"records":[`);
  let cursor: string | null = null;
  let firstRecord = true;
  const proofs: string[] = [];
  do {
    await renewLease();
    const page = await readPage(cursor);
    assertPageBound(page);
    firstRecord = await writePageRecords(writer, page.records, firstRecord);
    if (proofs.length + page.proofs.length > PRIVACY_EXPORT_PROOF_MAX) {
      throw new Error(`Entity privacy ${name} export exceeded the proof limit`);
    }
    proofs.push(...page.proofs);
    if (page.nextCursor !== null && page.nextCursor === cursor) {
      throw new Error(`Entity privacy ${name} export cursor did not advance`);
    }
    cursor = page.nextCursor;
  } while (cursor !== null);
  await writeJson(writer, `],"proofs":${JSON.stringify(proofs)}}`);
}

async function writePageRecords(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  records: readonly unknown[],
  firstRecord: boolean,
): Promise<boolean> {
  let isFirst = firstRecord;
  for (const record of records) {
    if (!isFirst) await writeJson(writer, ",");
    await writeJson(writer, JSON.stringify(record));
    isFirst = false;
  }
  return isFirst;
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

function writeJson(writer: WritableStreamDefaultWriter<Uint8Array>, value: string): Promise<void> {
  return writer.write(encoder.encode(value));
}

function toHex(value: ArrayBuffer): string {
  return [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
