import { Miniflare } from "miniflare";
import { describe, expect, it } from "vitest";
import {
  DurableExposureRedemptionClaimStore,
  type ExposureRedemptionClaimNamespace,
  exposureRedemptionClaimScopeName,
} from "./exposure-redemption-claim";
import { APP_B, ENV_B, EXPOSURE_ID_A, EXPOSURE_ID_B } from "./exposures-test-fixtures";
import { APP_ID, ENVIRONMENT_ID } from "./sdk-route-test-fixtures";

/**
 * Miniflare-hosted Durable Object that mirrors ExposureRedemptionClaimDurableObject.
 * Kept inline so the suite exercises the real DO isolation boundary without the
 * Worker vitest pool.
 */
const MINIFLARE_EXPOSURE_REDEMPTION_CLAIM_DO = `
import { DurableObject } from "cloudflare:workers";

const CLAIM_TTL_MS = 24 * 60 * 60 * 1000;
const EXPOSURE_KEY_PREFIX = "exposure:";
const TICKET_KEY_PREFIX = "ticket:";

export class ExposureRedemptionClaimDurableObject extends DurableObject {
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (request.method !== "POST") {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    const body = await request.json();
    const nowMs = typeof body.nowMs === "number" ? body.nowMs : Date.now();
    if (path === "/claim") {
      const outcome = await this.ctx.blockConcurrencyWhile(() =>
        claim(this.ctx.storage, body.exposureId, body.ticketFingerprint, nowMs),
      );
      return Response.json(outcome);
    }
    if (path === "/acknowledge") {
      const outcome = await this.ctx.blockConcurrencyWhile(() =>
        acknowledge(this.ctx.storage, body.exposureId, body.ticketFingerprint, nowMs),
      );
      return Response.json(outcome);
    }
    return Response.json({ error: "not found" }, { status: 404 });
  }

  async alarm() {
    const nowMs = Date.now();
    await deleteExpired(this.ctx.storage, nowMs);
  }
}

async function claim(storage, exposureId, ticketFingerprint, nowMs) {
  await deleteExpired(storage, nowMs);
  const existingExposure = await storage.get(EXPOSURE_KEY_PREFIX + exposureId);
  if (existingExposure !== undefined && existingExposure.expiresAt > nowMs) {
    if (existingExposure.ticketFingerprint !== ticketFingerprint) return { status: "conflict" };
    if (existingExposure.delivery === "accepted") return { status: "deduplicated" };
    return { status: "resume" };
  }
  const existingTicket = await storage.get(TICKET_KEY_PREFIX + ticketFingerprint);
  if (existingTicket !== undefined && existingTicket.expiresAt > nowMs) {
    await storage.put(EXPOSURE_KEY_PREFIX + exposureId, {
      ticketFingerprint,
      delivery: existingTicket.delivery,
      expiresAt: existingTicket.expiresAt,
    });
    return { status: "deduplicated" };
  }
  const expiresAt = nowMs + CLAIM_TTL_MS;
  await storage.put(EXPOSURE_KEY_PREFIX + exposureId, {
    ticketFingerprint,
    delivery: "pending",
    expiresAt,
  });
  await storage.put(TICKET_KEY_PREFIX + ticketFingerprint, {
    ownerExposureId: exposureId,
    delivery: "pending",
    expiresAt,
  });
  return { status: "acquired" };
}

async function acknowledge(storage, exposureId, ticketFingerprint, nowMs) {
  await deleteExpired(storage, nowMs);
  const existingExposure = await storage.get(EXPOSURE_KEY_PREFIX + exposureId);
  if (
    existingExposure === undefined ||
    existingExposure.expiresAt <= nowMs ||
    existingExposure.ticketFingerprint !== ticketFingerprint
  ) {
    throw new Error("missing claim");
  }
  if (existingExposure.delivery === "accepted") return { status: "already_accepted" };
  const existingTicket = await storage.get(TICKET_KEY_PREFIX + ticketFingerprint);
  const expiresAt =
    existingTicket !== undefined && existingTicket.expiresAt > nowMs
      ? existingTicket.expiresAt
      : existingExposure.expiresAt;
  await storage.put(EXPOSURE_KEY_PREFIX + exposureId, {
    ticketFingerprint,
    delivery: "accepted",
    expiresAt,
  });
  await storage.put(TICKET_KEY_PREFIX + ticketFingerprint, {
    ownerExposureId: existingTicket?.ownerExposureId ?? exposureId,
    delivery: "accepted",
    expiresAt,
  });
  return { status: "accepted" };
}

async function deleteExpired(storage, nowMs) {
  const entries = await storage.list();
  const expired = [];
  for (const [key, record] of entries) {
    if (
      (key.startsWith(EXPOSURE_KEY_PREFIX) || key.startsWith(TICKET_KEY_PREFIX)) &&
      record &&
      typeof record.expiresAt === "number" &&
      record.expiresAt <= nowMs
    ) {
      expired.push(key);
    }
  }
  if (expired.length > 0) await storage.delete(expired);
}
`;

const NOW = 1_700_000_000_000;

describe("DurableExposureRedemptionClaimStore Miniflare boundary", () => {
  it("serializes concurrent claims of one ticket to a single acquired owner", async () => {
    const mf = new Miniflare({
      modules: true,
      script: MINIFLARE_EXPOSURE_REDEMPTION_CLAIM_DO,
      compatibilityDate: "2026-06-21",
      compatibilityFlags: ["nodejs_compat"],
      durableObjects: {
        EXPOSURE_REDEMPTION_CLAIMS: { className: "ExposureRedemptionClaimDurableObject" },
      },
    });

    try {
      const namespace = (await mf.getDurableObjectNamespace(
        "EXPOSURE_REDEMPTION_CLAIMS",
      )) as unknown as ExposureRedemptionClaimNamespace;
      const store = new DurableExposureRedemptionClaimStore(namespace);

      const results = await Promise.all([
        store.claim({
          appId: APP_ID,
          environmentId: ENVIRONMENT_ID,
          exposureId: EXPOSURE_ID_A,
          ticketFingerprint: "ticket-shared",
          nowMs: NOW,
        }),
        store.claim({
          appId: APP_ID,
          environmentId: ENVIRONMENT_ID,
          exposureId: EXPOSURE_ID_B,
          ticketFingerprint: "ticket-shared",
          nowMs: NOW,
        }),
      ]);

      const statuses = results.map((result) => result.status).sort();
      expect(statuses).toEqual(["acquired", "deduplicated"]);

      const conflict = await store.claim({
        appId: APP_ID,
        environmentId: ENVIRONMENT_ID,
        exposureId: EXPOSURE_ID_B,
        ticketFingerprint: "ticket-other",
        nowMs: NOW,
      });
      expect(conflict).toEqual({ status: "conflict" });
    } finally {
      await mf.dispose();
    }
  });

  it("keeps independent Durable Object instances for distinct App/Environment scopes", async () => {
    const mf = new Miniflare({
      modules: true,
      script: MINIFLARE_EXPOSURE_REDEMPTION_CLAIM_DO,
      compatibilityDate: "2026-06-21",
      compatibilityFlags: ["nodejs_compat"],
      durableObjects: {
        EXPOSURE_REDEMPTION_CLAIMS: { className: "ExposureRedemptionClaimDurableObject" },
      },
    });

    try {
      const namespace = (await mf.getDurableObjectNamespace(
        "EXPOSURE_REDEMPTION_CLAIMS",
      )) as unknown as ExposureRedemptionClaimNamespace;
      const store = new DurableExposureRedemptionClaimStore(namespace);

      const nameA = exposureRedemptionClaimScopeName(APP_ID, ENVIRONMENT_ID);
      const nameB = exposureRedemptionClaimScopeName(APP_B, ENV_B);
      expect(nameA).not.toBe(nameB);

      const idA = namespace.idFromName(nameA);
      const idB = namespace.idFromName(nameB);
      expect(String(idA)).not.toBe(String(idB));

      await expect(
        store.claim({
          appId: APP_ID,
          environmentId: ENVIRONMENT_ID,
          exposureId: EXPOSURE_ID_A,
          ticketFingerprint: "shared-fp",
          nowMs: NOW,
        }),
      ).resolves.toEqual({ status: "acquired" });

      await expect(
        store.claim({
          appId: APP_B,
          environmentId: ENV_B,
          exposureId: EXPOSURE_ID_A,
          ticketFingerprint: "shared-fp",
          nowMs: NOW,
        }),
      ).resolves.toEqual({ status: "acquired" });
    } finally {
      await mf.dispose();
    }
  });

  it("resumes a pending claim across independent stub fetches after ingest-window failure", async () => {
    const mf = new Miniflare({
      modules: true,
      script: MINIFLARE_EXPOSURE_REDEMPTION_CLAIM_DO,
      compatibilityDate: "2026-06-21",
      compatibilityFlags: ["nodejs_compat"],
      durableObjects: {
        EXPOSURE_REDEMPTION_CLAIMS: { className: "ExposureRedemptionClaimDurableObject" },
      },
    });

    try {
      const namespace = (await mf.getDurableObjectNamespace(
        "EXPOSURE_REDEMPTION_CLAIMS",
      )) as unknown as ExposureRedemptionClaimNamespace;
      // Two store wrappers = two independent stub get() paths against the same DO.
      const storeA = new DurableExposureRedemptionClaimStore(namespace);
      const storeB = new DurableExposureRedemptionClaimStore(namespace);

      await expect(
        storeA.claim({
          appId: APP_ID,
          environmentId: ENVIRONMENT_ID,
          exposureId: EXPOSURE_ID_A,
          ticketFingerprint: "ticket-resume",
          nowMs: NOW,
        }),
      ).resolves.toEqual({ status: "acquired" });

      // Simulate transient ingest failure: no acknowledge yet.
      await expect(
        storeB.claim({
          appId: APP_ID,
          environmentId: ENVIRONMENT_ID,
          exposureId: EXPOSURE_ID_A,
          ticketFingerprint: "ticket-resume",
          nowMs: NOW,
        }),
      ).resolves.toEqual({ status: "resume" });

      await expect(
        storeB.acknowledge({
          appId: APP_ID,
          environmentId: ENVIRONMENT_ID,
          exposureId: EXPOSURE_ID_A,
          ticketFingerprint: "ticket-resume",
          nowMs: NOW,
        }),
      ).resolves.toEqual({ status: "accepted" });

      await expect(
        storeA.claim({
          appId: APP_ID,
          environmentId: ENVIRONMENT_ID,
          exposureId: EXPOSURE_ID_B,
          ticketFingerprint: "ticket-resume",
          nowMs: NOW,
        }),
      ).resolves.toEqual({ status: "deduplicated" });
    } finally {
      await mf.dispose();
    }
  });
});
