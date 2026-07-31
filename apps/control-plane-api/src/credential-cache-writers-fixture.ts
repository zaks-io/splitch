import { CredentialCacheKVSchema, kvEnvelope } from "@splitch/contracts";
import type { CredentialCacheWriter } from "./credential-cache";

/**
 * Test doubles for the credential cache write path: a serializing writer and the
 * two authority-checking variants that mirror CredentialCacheWriterDurableObject.
 */

const cacheEnvelope = kvEnvelope(CredentialCacheKVSchema);

export class SerialWriter implements CredentialCacheWriter {
  private tail = Promise.resolve();

  constructor(private readonly writes: Map<string, string>) {}

  put({ key, value }: Parameters<CredentialCacheWriter["put"]>[0]): Promise<void> {
    const write = this.tail.then(() => {
      this.writes.set(key, value);
    });
    this.tail = write;
    return write;
  }
}

/** Mirrors the CredentialCacheWriterDurableObject authority checks. */
export class AuthoritativeSerialWriter extends SerialWriter {
  revoked = false;
  originAllowlist: string[] | null = null;

  override async put(write: Parameters<CredentialCacheWriter["put"]>[0]): Promise<void> {
    const candidate = cacheEnvelope.parse(JSON.parse(write.value)).data;
    if (candidate.revoked !== this.revoked) {
      throw new Error("credential cache write rejected: revocation state is stale");
    }
    const candidateAllowlist =
      candidate.kind === "client_key" ? (candidate.originAllowlist ?? null) : null;
    if (JSON.stringify(candidateAllowlist) !== JSON.stringify(this.originAllowlist)) {
      throw new Error("credential cache write rejected: Client Key restrictions are stale");
    }
    await super.put(write);
  }
}

/**
 * Serializes the two candidate writes into a chosen order, and flips the
 * authoritative allowlist as the restriction write lands — mirroring production,
 * where the restriction is committed to D1 before its cache write is issued.
 */
export class OrderedWriter extends AuthoritativeSerialWriter {
  private readonly firstLanded: Promise<void>;
  private releaseFirst: () => void = () => {};

  constructor(
    writes: Map<string, string>,
    private readonly first: "backfill" | "restriction",
  ) {
    super(writes);
    this.firstLanded = new Promise((resolve) => {
      this.releaseFirst = resolve;
    });
  }

  override async put(write: Parameters<CredentialCacheWriter["put"]>[0]): Promise<void> {
    const candidate = cacheEnvelope.parse(JSON.parse(write.value)).data;
    const isRestriction =
      candidate.kind === "client_key" && (candidate.originAllowlist ?? null) !== null;
    const isFirst = isRestriction === (this.first === "restriction");
    if (!isFirst) await this.firstLanded;
    if (isRestriction) this.originAllowlist = candidate.originAllowlist ?? null;

    try {
      await super.put(write);
    } finally {
      if (isFirst) this.releaseFirst();
    }
  }
}

export function writerAccess(writer: CredentialCacheWriter) {
  return { writerFor: () => writer };
}
