/**
 * Derive the App-scoped `app_privacy_salt` from a deployment root secret.
 *
 * One hosted Worker secret is not itself an App salt. Using it directly would
 * make the same Targeting Key compare equal across Apps. The derived key is:
 *
 *   HMAC_SHA256(root_secret, "app-privacy-salt:" + key_version + ":" + appId)
 *
 * Version stays in the message so a later key-version bump is a new identity
 * epoch without rotating the deployment secret. Historical shared-root prefixes
 * (`v1`, `local-v1`) are not derived here; the salt store serves the raw root
 * for those versions so retained rows stay comparable. The raw Targeting Key is
 * never an input here.
 */

import { hmacSha256, utf8Bytes } from "./hmac";
import type { KeyVersion, SaltBytes } from "./salt-store";

const DERIVATION_PREFIX = "app-privacy-salt";

export interface DeriveAppPrivacySaltInput {
  rootSecret: string | SaltBytes;
  appId: string;
  keyVersion: KeyVersion;
}

function asRootSecret(rootSecret: string | SaltBytes): SaltBytes {
  if (typeof rootSecret === "string") {
    if (rootSecret.length === 0) {
      throw new Error("privacy: empty root privacy secret");
    }
    return utf8Bytes(rootSecret);
  }
  if (rootSecret.length === 0) {
    throw new Error("privacy: empty root privacy secret");
  }
  return rootSecret;
}

function validateDerivationLabel(field: string, value: string): void {
  if (value.length === 0) {
    throw new Error(`privacy: ${field} must not be empty`);
  }
  if (value.includes(":")) {
    throw new Error(`privacy: ${field} must not contain ':'`);
  }
}

/** Domain-separated message bound to one App identity epoch. */
export function appPrivacySaltMessage(appId: string, keyVersion: KeyVersion): string {
  validateDerivationLabel("appId", appId);
  validateDerivationLabel("keyVersion", keyVersion);
  return `${DERIVATION_PREFIX}:${keyVersion}:${appId}`;
}

/** App-specific HMAC key material for one `(root, appId, keyVersion)` triple. */
export async function deriveAppPrivacySalt(input: DeriveAppPrivacySaltInput): Promise<SaltBytes> {
  const root = asRootSecret(input.rootSecret);
  const digest = await hmacSha256(root, appPrivacySaltMessage(input.appId, input.keyVersion));
  return new Uint8Array(digest) as SaltBytes;
}
