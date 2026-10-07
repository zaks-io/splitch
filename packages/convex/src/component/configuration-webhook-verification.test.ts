import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { handleConfigurationWebhook } from "./configuration-webhook";

const SECRET = "current-webhook-secret-for-tests";
const PREVIOUS_SECRET = "previous-webhook-secret-for-tests";
const INSTALLATION_ID = "f35d40f3-e178-4e5c-a45b-251790247fd1";
const CHALLENGE = "018f7a42-8c11-7c5a-9d4e-123456789abc";
const TIMESTAMP = "1780000000";
const verification = {
  type: "callback.verify",
  installationId: INSTALLATION_ID,
  challenge: CHALLENGE,
};

describe("configuration callback verification", () => {
  it("returns the current-secret proof without announcing a configuration change", async () => {
    const deps = webhookDeps();

    const response = await handleConfigurationWebhook(signedRequest(verification), deps);

    expect(response.status).toBe(204);
    expect(response.headers.get("splitch-callback-proof")).toBe(
      digest(SECRET, `callback.verify:${INSTALLATION_ID}:${CHALLENGE}`),
    );
    expect(await response.text()).toBe("");
    expect(deps.announce).not.toHaveBeenCalled();
  });

  it.each([
    { ...verification, installationId: "845fe4c4-477f-4ea0-b04c-f033917655ea" },
    { ...verification, installationId: "not-a-uuid" },
    { ...verification, challenge: "not-a-uuid" },
    { type: "callback.verify", installationId: INSTALLATION_ID },
    { ...verification, webhookSecret: SECRET },
    { ...verification, type: "unknown" },
  ])("rejects an invalid or wrong-installation challenge %j", async (body) => {
    const deps = webhookDeps();

    const response = await handleConfigurationWebhook(signedRequest(body), deps);

    expect(response.status).toBe(400);
    expect(response.headers.has("splitch-callback-proof")).toBe(false);
    expect(deps.announce).not.toHaveBeenCalled();
  });

  it.each(["unsigned", "invalid signature", "expired"])(
    "rejects an %s verification",
    async (failure) => {
      const request = signedRequest(
        verification,
        SECRET,
        failure === "expired" ? "1779999699" : TIMESTAMP,
      );
      if (failure === "unsigned") request.headers.delete("splitch-signature");
      if (failure === "invalid signature") request.headers.set("splitch-signature", "v1=deadbeef");
      const deps = webhookDeps();

      const response = await handleConfigurationWebhook(request, deps);

      expect(response.status).toBe(401);
      expect(response.headers.has("splitch-callback-proof")).toBe(false);
      expect(deps.announce).not.toHaveBeenCalled();
    },
  );

  it("rejects verification signed by the previous secret during rotation", async () => {
    const deps = webhookDeps();

    const response = await handleConfigurationWebhook(
      signedRequest(verification, PREVIOUS_SECRET),
      deps,
    );

    expect(response.status).toBe(401);
    expect(response.headers.has("splitch-callback-proof")).toBe(false);
    expect(deps.announce).not.toHaveBeenCalled();
  });

  it("continues accepting configuration nudges signed by the previous secret", async () => {
    const deps = webhookDeps();
    const body = {
      type: "config.changed",
      deliveryId: CHALLENGE,
      appId: "app_1",
      environmentId: "env_1",
      environmentVersion: 7,
      changed: { entity: "flag", id: "flag_1" },
    };
    const request = signedRequest(body, PREVIOUS_SECRET);
    request.headers.set("splitch-delivery-id", CHALLENGE);

    const response = await handleConfigurationWebhook(request, deps);

    expect(response.status).toBe(202);
    expect(response.headers.has("splitch-callback-proof")).toBe(false);
    expect(deps.announce).toHaveBeenCalledOnce();
  });
});

function digest(secret: string, message: string): string {
  return createHmac("sha256", secret).update(message).digest("hex");
}

function signedRequest(body: unknown, secret = SECRET, timestamp = TIMESTAMP): Request {
  const raw = JSON.stringify(body);
  return new Request("https://hooks.example.com/integrations/splitch/configuration", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "splitch-timestamp": timestamp,
      "splitch-signature": `v1=${digest(secret, `${timestamp}.${raw}`)}`,
    },
    body: raw,
  });
}

function webhookDeps() {
  return {
    nowSeconds: () => Number(TIMESTAMP),
    getIntegration: vi.fn(async () => ({
      installationId: INSTALLATION_ID,
      webhookSecret: SECRET,
      previousWebhookSecret: PREVIOUS_SECRET,
    })),
    announce: vi.fn(async () => {}),
  };
}
