import {
  CredentialCacheKVSchema,
  credentialRevocationCacheKey,
  kvEnvelope,
  TERMINAL_CREDENTIAL_REVOCATION_MARKER,
} from "@splitch/contracts";
import type { CredentialCacheWriter } from "./credential-cache";

/**
 * Credential-cache concurrency doubles: one raw KV ordering store plus the
 * serializing writer and authority-checking writer variants.
 */

const cacheEnvelope = kvEnvelope(CredentialCacheKVSchema);

class SerialWriter implements CredentialCacheWriter {
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

export class StaleBackfillWinsStore {
  private readonly revocationLanded: Promise<void>;
  private releaseRevocation: () => void = () => {};

  constructor(
    private readonly writes: Map<string, string>,
    private readonly credentialCacheKey: string,
  ) {
    this.revocationLanded = new Promise((resolve) => {
      this.releaseRevocation = resolve;
    });
  }

  get(key: string): Promise<string | null> {
    return Promise.resolve(this.writes.get(key) ?? null);
  }

  async put(key: string, value: string): Promise<void> {
    if (key === credentialRevocationCacheKey(this.credentialCacheKey)) {
      if (value !== TERMINAL_CREDENTIAL_REVOCATION_MARKER) {
        throw new Error("test fixture received an invalid terminal revocation marker");
      }
      this.writes.set(key, value);
      return;
    }

    const candidate = cacheEnvelope.parse(JSON.parse(value)).data;
    if (!candidate.revoked) await this.revocationLanded;
    this.writes.set(key, value);
    if (candidate.revoked) this.releaseRevocation();
  }
}

/** Covers the Durable Object's revocation and Client Key restriction authority decisions. */
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
