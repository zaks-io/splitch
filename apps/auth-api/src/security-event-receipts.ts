const RECEIPT_PREFIX = "security-event:";
const RECEIPT_TTL_SECONDS = 8 * 24 * 60 * 60;

export interface SecurityEventReceiptStore {
  /** Returns true for a prior delivery. Concurrent duplicates may both return false. */
  seenOrRecord(issuer: string, jti: string): Promise<boolean>;
}

/**
 * SET actions are idempotent, so KV's non-atomic check/write can only repeat the
 * same revocation. The receipt exists to avoid ordinary provider retries.
 */
export function makeSecurityEventReceiptStore(kv: KVNamespace): SecurityEventReceiptStore {
  return {
    async seenOrRecord(issuer, jti) {
      const key = `${RECEIPT_PREFIX}${await receiptDigest(issuer, jti)}`;
      if ((await kv.get(key)) !== null) return true;
      await kv.put(key, "1", { expirationTtl: RECEIPT_TTL_SECONDS });
      return false;
    },
  };
}

async function receiptDigest(issuer: string, jti: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${issuer}\0${jti}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
