import type { FlagChangeEventRow, Repository, SentryInstallationRow } from "@splitch/db";
import { describe, expect, it, vi } from "vitest";
import { dispatchSentryWebhooks } from "./sentry-webhook-dispatch";
import { encryptIntegrationSecret, signIntegrationPayload } from "./integration-secret";

const KEK = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const SECRET = "sentry-signing-secret";
const NOW = new Date("2026-08-25T12:00:00.000Z");
const URL_OK = "https://sentry.io/api/0/organizations/acme/flags/hooks/provider/generic/";

describe("Sentry change-tracking dispatch", () => {
  it("signs the exact posted body and advances the cursor to the highest seq", async () => {
    const { repo, successes } = await fixture();
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = init?.body as string;
      expect(new Headers(init?.headers).get("x-sentry-signature")).toBe(
        await signIntegrationPayload(SECRET, body),
      );
      expect(init?.redirect).toBe("manual");
      expect(JSON.parse(body)).toEqual({
        data: [
          {
            action: "updated",
            change_id: 11,
            created_at: "2026-08-25T11:00:00",
            created_by: { id: "user_a", type: "id" },
            flag: "checkout-flow",
          },
          {
            action: "deleted",
            change_id: 12,
            created_at: "2026-08-25T11:30:00",
            created_by: { id: "user_a", type: "id" },
            flag: "checkout-flow",
          },
        ],
        meta: { version: 1 },
      });
      // Sentry answers 201, which `Response.ok` covers but a `=== 200` would not.
      return new Response(null, { status: 201 });
    });

    await expect(
      dispatchSentryWebhooks({ repo, secretKek: KEK, fetcher, now: () => NOW }),
    ).resolves.toBe(2);
    expect(successes).toEqual([
      {
        installationId: "00000000-0000-4000-8000-000000000001",
        deliveredSeq: 12,
        now: NOW.toISOString(),
      },
    ]);
  });

  it("leaves the cursor where it is when Sentry rejects the batch", async () => {
    for (const status of [400, 401, 503]) {
      const { repo, successes, failures } = await fixture();
      await dispatchSentryWebhooks({
        repo,
        secretKek: KEK,
        fetcher: async () => new Response(null, { status }),
        now: () => NOW,
      });
      // Skipping past a rejected batch would drop those changes silently; the
      // backlog stays put and the failure stays visible on the installation.
      expect(successes).toEqual([]);
      expect(failures).toHaveLength(1);
      expect(JSON.parse(String(failures[0]?.errorJson))).toMatchObject({ httpStatus: status });
    }
  });

  it("refuses to POST to a host that no longer passes the URL guard", async () => {
    const fetcher = vi.fn();
    const { repo, failures } = await fixture({
      installation: { webhookUrl: "https://evil.example/api/0/x" },
    });
    await dispatchSentryWebhooks({ repo, secretKek: KEK, fetcher, now: () => NOW });
    expect(fetcher).not.toHaveBeenCalled();
    expect(JSON.parse(String(failures[0]?.errorJson))).toMatchObject({ code: "URL_REJECTED" });
  });

  it("does not record a delivery when there is nothing pending", async () => {
    const fetcher = vi.fn();
    const { repo, successes } = await fixture({ events: [] });
    await expect(
      dispatchSentryWebhooks({ repo, secretKek: KEK, fetcher, now: () => NOW }),
    ).resolves.toBe(0);
    expect(fetcher).not.toHaveBeenCalled();
    // Recording success here would reset the backoff of an installation that has
    // never actually reached Sentry.
    expect(successes).toEqual([]);
  });

  it("resumes strictly after the stored cursor", async () => {
    const seen: number[] = [];
    const { repo } = await fixture({
      installation: { lastDeliveredSeq: 11 },
      onPending: (afterSeq) => seen.push(afterSeq),
    });
    await dispatchSentryWebhooks({
      repo,
      secretKek: KEK,
      fetcher: async () => new Response(null, { status: 201 }),
      now: () => NOW,
    });
    expect(seen).toEqual([11]);
  });

  it("records a broken installation's fault instead of taking the batch down with it", async () => {
    const { repo, successes, failures } = await fixture({
      // A KEK-version mismatch throws out of the decrypt, the one failure mode
      // that is not an HTTP or transport outcome.
      installations: [
        { installationId: "broken", secretKeyVersion: "v0" },
        { installationId: "healthy" },
      ],
    });
    await expect(
      dispatchSentryWebhooks({
        repo,
        secretKek: KEK,
        fetcher: async () => new Response(null, { status: 201 }),
        now: () => NOW,
      }),
      // The whole tick rejecting would leave every other installation's cursor
      // unadvanced and its failure unrecorded, repeating silently every minute.
    ).resolves.toBe(2);
    expect(successes).toEqual([
      { installationId: "healthy", deliveredSeq: 12, now: NOW.toISOString() },
    ]);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.installationId).toBe("broken");
    expect(JSON.parse(String(failures[0]?.errorJson))).toMatchObject({ code: "DISPATCH_FAILED" });
  });
});

function event(overrides: Partial<FlagChangeEventRow>): FlagChangeEventRow {
  return {
    seq: 11,
    appId: "app_a",
    environmentId: "env_a",
    flagKey: "checkout-flow",
    action: "updated",
    targetType: "flag_config",
    actorRef: "user_a",
    actorVia: "api-key",
    changedAt: "2026-08-25T11:00:00.000Z",
    ...overrides,
  };
}

async function fixture(
  options: {
    installation?: Partial<SentryInstallationRow>;
    installations?: Array<Partial<SentryInstallationRow>>;
    events?: FlagChangeEventRow[];
    onPending?: (afterSeq: number) => void;
  } = {},
) {
  const encrypted = await encryptIntegrationSecret(SECRET, KEK, "v1", "INTEGRATION_SECRET_KEK");
  const successes: Array<Record<string, unknown>> = [];
  const failures: Array<Record<string, unknown>> = [];
  const events = options.events ?? [
    event({ seq: 11 }),
    event({ seq: 12, action: "deleted", changedAt: "2026-08-25T11:30:00.000Z" }),
  ];

  const overrides = options.installations ?? [options.installation ?? {}];
  const sentry = {
    dueInstallations: async () =>
      overrides.map(
        (override) =>
          ({
            installationId: "00000000-0000-4000-8000-000000000001",
            appId: "app_a",
            environmentId: "env_a",
            webhookUrl: URL_OK,
            secretCiphertext: encrypted.ciphertext,
            secretKeyVersion: encrypted.keyVersion,
            secretFingerprint: encrypted.fingerprint,
            status: "active",
            lastDeliveredSeq: null,
            attemptCount: 0,
            ...override,
          }) as SentryInstallationRow,
      ),
    recordSuccess: async (installationId: string, deliveredSeq: number, now: string) => {
      successes.push({ installationId, deliveredSeq, now });
    },
    recordFailure: async (installationId: string, input: Record<string, unknown>) => {
      failures.push({ installationId, ...input });
    },
  };
  const flagChangeEvents = {
    pendingForScope: async (_appId: string, _envId: string, afterSeq: number) => {
      options.onPending?.(afterSeq);
      return events;
    },
  };
  return { repo: { sentry, flagChangeEvents } as unknown as Repository, successes, failures };
}
