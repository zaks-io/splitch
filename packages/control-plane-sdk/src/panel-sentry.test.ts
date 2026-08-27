import { describe, expect, it, vi } from "vitest";
import { createPanelSentryClient } from "./panel-sentry";

/**
 * The Panel half of the Sentry exchange. What matters here is that the
 * Environment is in the PATH — the delegation claim is derived from it, so an
 * installation reachable without naming its Environment would be unbindable —
 * and that a minted secret survives the round trip exactly as sent.
 */

const SCOPE = { appId: "app_1", environmentId: "env_prod" };
const WEBHOOK = "https://zaksio.sentry.io/api/0/organizations/zaksio/flags/hooks/provider/generic/";
const INSTALLATION_ID = "11111111-1111-4111-8111-111111111111";

function stubFetch(response: Response) {
  return vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response);
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const INSTALLATION = {
  installationId: INSTALLATION_ID,
  appId: "app_1",
  environmentId: "env_prod",
  webhookUrl: WEBHOOK,
  status: "active" as const,
};

describe("panel Sentry client", () => {
  it("lists installations from the Environment-scoped path", async () => {
    const fetch = stubFetch(
      json({
        items: [
          {
            ...INSTALLATION,
            lastDeliveredSeq: 12,
            lastDeliveredAt: "2026-08-26T00:00:00.000Z",
            attemptCount: 0,
            nextAttemptAt: "2026-08-26T00:01:00.000Z",
            latestDeliveryError: null,
          },
        ],
        readLimit: 200,
        readTruncated: false,
        cursor: null,
      }),
    );
    const client = createPanelSentryClient({ fetch: fetch as unknown as typeof globalThis.fetch });

    const result = await client.list(SCOPE);

    expect(String(fetch.mock.calls[0]?.[0])).toBe(
      "https://control-plane.internal/apps/app_1/envs/env_prod/integrations/sentry/installations",
    );
    expect(result.ok && result.data.items[0]?.lastDeliveredSeq).toBe(12);
  });

  it("carries the minted signing secret back to the caller", async () => {
    const fetch = stubFetch(json({ ...INSTALLATION, webhookSecret: "a".repeat(64) }));
    const client = createPanelSentryClient({ fetch: fetch as unknown as typeof globalThis.fetch });

    const result = await client.install({
      ...SCOPE,
      installationId: INSTALLATION_ID,
      webhookUrl: WEBHOOK,
    });

    const request = fetch.mock.calls[0]?.[1] as RequestInit;
    expect(request.method).toBe("POST");
    // The Panel never supplies a secret: omitting it is what makes the server mint one.
    expect(JSON.parse(String(request.body))).toEqual({
      installationId: INSTALLATION_ID,
      webhookUrl: WEBHOOK,
    });
    expect(result.ok && result.data.webhookSecret).toBe("a".repeat(64));
  });

  it("posts a rotation to the installation's own path", async () => {
    const rotationId = "22222222-2222-4222-8222-222222222222";
    const fetch = stubFetch(
      json({
        installationId: INSTALLATION_ID,
        rotationId,
        status: "active",
        webhookSecret: "b".repeat(64),
      }),
    );
    const client = createPanelSentryClient({ fetch: fetch as unknown as typeof globalThis.fetch });

    const result = await client.rotateSecret({
      ...SCOPE,
      installationId: INSTALLATION_ID,
      rotationId,
    });

    expect(String(fetch.mock.calls[0]?.[0])).toBe(
      "https://control-plane.internal/apps/app_1/envs/env_prod" +
        `/integrations/sentry/installations/${INSTALLATION_ID}/secret-rotations`,
    );
    expect(result.ok && result.data.webhookSecret).toBe("b".repeat(64));
  });

  it("reads a 204 revoke as the success it is", async () => {
    const fetch = stubFetch(new Response(null, { status: 204 }));
    const client = createPanelSentryClient({ fetch: fetch as unknown as typeof globalThis.fetch });

    const result = await client.revoke({ ...SCOPE, installationId: INSTALLATION_ID });

    expect((fetch.mock.calls[0]?.[1] as RequestInit).method).toBe("DELETE");
    expect(result).toEqual({ ok: true, data: { revoked: true }, status: 204 });
  });

  it("surfaces a refusal verbatim instead of throwing", async () => {
    const fetch = stubFetch(
      json(
        {
          code: "VALIDATION_ERROR",
          message: "webhook host is not Sentry",
          details: {
            issues: [{ path: ["body", "webhookUrl"], message: "webhook host is not Sentry" }],
          },
        },
        400,
      ),
    );
    const client = createPanelSentryClient({ fetch: fetch as unknown as typeof globalThis.fetch });

    const result = await client.install({
      ...SCOPE,
      installationId: INSTALLATION_ID,
      webhookUrl: "https://attacker.example/hook",
    });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.message).toBe("webhook host is not Sentry");
  });
});
