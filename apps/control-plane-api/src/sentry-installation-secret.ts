import { randomHex } from "./credential-cache";
import { encryptIntegrationSecret } from "./integration-secret";

/**
 * Minting and sealing the Sentry webhook signing secret.
 *
 * Sentry never issues this value: its Add-Provider form asks you to paste "the
 * signing secret given by your provider", so splitch is the provider. A caller
 * that already holds one (an agent rotating from its own keystore) sends it and
 * it is stored verbatim; a caller that does not gets one minted here and
 * returned exactly once, like a minted API Key.
 *
 * 32 bytes of `crypto.getRandomValues` rendered as 64 hex characters, which is
 * the top of Sentry's documented 10-64 character range.
 */

const SECRET_BYTES = 32;

export interface SealedSentrySecret {
  ciphertext: string;
  keyVersion: string;
  fingerprint: string;
  /** Set only when this call minted the secret, so the caller can surface it once. */
  minted: string | null;
}

export interface SentrySecretSealingDeps {
  secretKek?: string;
  secretKeyVersion?: string;
}

export async function sealSentrySecret(
  supplied: string | undefined,
  deps: SentrySecretSealingDeps,
): Promise<SealedSentrySecret> {
  const secret = supplied ?? randomHex(SECRET_BYTES);
  const encrypted = await encryptIntegrationSecret(
    secret,
    deps.secretKek,
    deps.secretKeyVersion,
    "INTEGRATION_SECRET_KEK",
  );
  return { ...encrypted, minted: supplied === undefined ? secret : null };
}
