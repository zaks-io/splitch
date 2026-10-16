import { expect, vi } from "vitest";
import { forwardAuditEvents } from "../src/audit-events";
import { runControlPlaneScheduled } from "../src/scheduled";
import type { AuditTinybirdFixture } from "./audit-tinybird-fixture";

export async function proveAuditDeliveryRecovery(h: AuditTinybirdFixture) {
  const payloads: string[] = [];
  const sent: typeof fetch = async (request, init) => {
    if (new URL(String(request)).pathname === "/v0/events") payloads.push(String(init?.body));
    return h.network(request, init);
  };
  for (let i = 0; i < 2; i++) {
    const minted = await h.mint();
    expect(minted.status).toBe(200);
    const body = (await minted.json()) as { value: string };
    h.canaries.push(body.value);
  }
  let rows = await h.events();
  expect(rows).toHaveLength(2);
  expect(new Set(rows.map((row) => row.eventId)).size).toBe(2);
  expect(new Set(rows.map((row) => row.resourceId)).size).toBe(2);
  await expect(
    forwardAuditEvents({
      repo: h.repo,
      env: h.env,
      fetchFn: async (request, init) => {
        const accepted = await sent(request, init);
        expect(accepted.status).toBe(200);
        await accepted.arrayBuffer();
        throw new Error("test: accepted append response lost");
      },
    }),
  ).rejects.toThrow("response lost");
  expect((await h.events()).every((row) => row.forwardedAt === null)).toBe(true);
  expect(await forwardAuditEvents({ repo: h.repo, env: h.env, fetchFn: sent })).toBe(2);
  expect((await h.events()).every((row) => row.forwardedAt !== null)).toBe(true);
  const third = await h.mint();
  expect(third.status).toBe(200);
  h.canaries.push(((await third.json()) as { value: string }).value);
  await expect(
    forwardAuditEvents({
      repo: h.repo,
      env: h.env,
      fetchFn: async () => new Response(null, { status: 503 }),
    }),
  ).rejects.toThrow("HTTP 503");
  rows = await h.events();
  const failed = rows.find((row) => row.forwardedAt === null);
  if (!failed) throw new Error("Expected the rejected append to remain pending");
  // All events are older than 90 days. Only the accepted pair may be pruned.
  expect(
    await h.repo.auditEvents.pruneBefore({ changedBefore: new Date().toISOString(), limit: 100 }),
  ).toBe(2);
  expect((await h.events()).map((row) => row.eventId)).toEqual([failed.eventId]);
  await runAuditCron(h, sent);
  return { rows, payloads };
}

async function runAuditCron(h: AuditTinybirdFixture, sent: typeof fetch) {
  vi.stubGlobal("fetch", sent);
  try {
    const waits: Promise<unknown>[] = [];
    runControlPlaneScheduled(
      {
        cron: "* * * * *",
        scheduledTime: Date.now(),
        noRetry: () => undefined,
      } as ScheduledController,
      h.env,
      {
        waitUntil: (promise: Promise<unknown>) => {
          waits.push(promise);
        },
      } as ExecutionContext,
    );
    const cron = await Promise.allSettled(waits);
    expect(cron.filter((result) => result.status === "rejected")).toEqual([]);
    const delivered = await h.events();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.forwardedAt).toEqual(expect.any(String));
  } finally {
    vi.unstubAllGlobals();
  }
}
