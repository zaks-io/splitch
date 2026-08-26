import { hmacHex } from "./crypto";

export const baseSnapshot = {
  schemaVersion: 1 as const,
  environmentVersion: 1,
  appId: "app_1",
  environmentId: "env_1",
  flags: [
    {
      id: "flag_1",
      key: "checkout",
      environmentId: "env_1",
      experimentId: null,
      enabled: true,
      defaultVariantId: "control",
      variants: [
        { id: "control", name: "control", value: false },
        { id: "treatment", name: "treatment", value: true },
      ],
      availableVariantNames: ["control", "treatment"],
      targetingRules: [],
      rollout: null,
      updatedAt: "2026-08-25T00:00:00.000Z",
    },
  ],
  experiments: [],
  runs: [],
};

export function configurationPushFixture(
  secret: string,
  workerFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
) {
  async function signedHeaders(body: string, deliveryId: string, signature?: string) {
    const timestamp = String(Math.floor(Date.now() / 1_000));
    const digest = signature ?? (await hmacHex(secret, `${timestamp}.${deliveryId}.${body}`));
    return {
      "content-type": "application/json",
      "splitch-delivery-id": deliveryId,
      "splitch-timestamp": timestamp,
      "splitch-signature": `v1=${digest}`,
    };
  }

  return {
    signedHeaders,
    async push(snapshot: unknown, deliveryId: string): Promise<Response> {
      const body = JSON.stringify(snapshot);
      return workerFetch("https://worker.test/integrations/splitch/configuration", {
        method: "POST",
        headers: await signedHeaders(body, deliveryId),
        body,
      });
    },
  };
}
