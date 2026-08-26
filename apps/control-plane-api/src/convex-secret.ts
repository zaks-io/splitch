import {
  decryptIntegrationSecret,
  encryptIntegrationSecret,
  signIntegrationPayload,
} from "./integration-secret";

const KEY_NAME = "CONVEX_WEBHOOK_KEK";

export function encryptConvexSecret(
  secret: string,
  base64Key: string | undefined,
  keyVersion: string | undefined,
) {
  return encryptIntegrationSecret(secret, base64Key, keyVersion, KEY_NAME);
}

export function decryptConvexSecret(
  ciphertext: string,
  base64Key: string | undefined,
  storedKeyVersion: string,
  configuredKeyVersion: string | undefined,
) {
  return decryptIntegrationSecret(
    ciphertext,
    base64Key,
    storedKeyVersion,
    configuredKeyVersion,
    KEY_NAME,
  );
}

export function signConvexWebhook(secret: string, timestamp: string, body: string) {
  return signIntegrationPayload(secret, `${timestamp}.${body}`);
}
