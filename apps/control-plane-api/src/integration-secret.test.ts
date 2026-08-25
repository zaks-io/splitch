import { describe, expect, it } from "vitest";
import {
  decryptIntegrationSecret,
  encryptIntegrationSecret,
  signIntegrationPayload,
} from "./integration-secret";

const kek = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

describe("integration secrets", () => {
  it("encrypts without exposing plaintext and decrypts with the configured KEK", async () => {
    const encrypted = await encryptIntegrationSecret(
      "push-secret",
      kek,
      "v1",
      "INTEGRATION_SECRET_KEK",
    );

    expect(encrypted.ciphertext).not.toContain("push-secret");
    expect(encrypted.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    await expect(
      decryptIntegrationSecret(encrypted.ciphertext, kek, "INTEGRATION_SECRET_KEK"),
    ).resolves.toBe("push-secret");
  });

  it("signs the exact timestamp, delivery ID, and body bytes", async () => {
    const canonical = await signIntegrationPayload("push-secret", '1.delivery.{"a":1}');
    const changed = await signIntegrationPayload("push-secret", '1.delivery.{"a":1 } ');

    expect(canonical).toMatch(/^[a-f0-9]{64}$/);
    expect(changed).not.toBe(canonical);
  });
});
