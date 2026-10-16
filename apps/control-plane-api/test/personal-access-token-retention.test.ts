import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ControlPlaneApiEnv } from "../src/env";
import { runPersonalAccessTokenRetention } from "../src/personal-access-token-rotation";
import { runControlPlaneScheduled } from "../src/scheduled";
import { stepUpFixture, USER } from "./personal-access-token-step-up-fixture";

let f: Awaited<ReturnType<typeof stepUpFixture>>;
beforeEach(async () => {
  f = await stepUpFixture();
});
afterEach(async () => {
  await f.bindings.dispose();
});

describe("scheduled PAT consumption retention on real D1", () => {
  it("purges inactive users globally in bounded pages only after expiry plus 24 hours", async () => {
    const initial = f.now();
    const oldExpiry = new Date(initial - 24 * 3600_000 - 1).toISOString();
    await f.bindings.d1.batch(
      Array.from({ length: 205 }, (_, i) =>
        f.bindings.d1
          .prepare("INSERT INTO personal_access_token_step_up_uses VALUES (?,?,?,?)")
          .bind(
            `old-${i}`,
            `inactive-${i}`,
            new Date(initial - 48 * 3600_000).toISOString(),
            oldExpiry,
          ),
      ),
    );
    const approval = await f.approval();
    const body = { name: "fresh", grants: [{ target: "all", role: "member", permissions: [] }] };
    expect((await f.call("POST", "/personal-access-tokens", body, { approval })).status).toBe(200);
    const count = async () =>
      (
        await f.bindings.d1
          .prepare("SELECT count(*) AS n FROM personal_access_token_step_up_uses")
          .first<{ n: number }>()
      )?.n;
    for (const remaining of [106, 6, 1]) {
      await scheduledRetention(initial);
      expect(await count()).toBe(remaining);
      expect((await f.call("POST", "/personal-access-tokens", body, { approval })).status).toBe(
        403,
      );
    }
    // Even after JWT expiry, retain terminal consumption until the full 24-hour margin passes.
    f.setNow(initial + 24 * 3600_000);
    await runPersonalAccessTokenRetention(f.repo.personalAccessTokens, f.bindings.kv, f.now());
    expect(await count()).toBe(1);
    f.setNow(initial + 24 * 3600_000 + 301_000);
    await runPersonalAccessTokenRetention(f.repo.personalAccessTokens, f.bindings.kv, f.now());
    expect(await count()).toBe(0);
    expect((await f.call("POST", "/personal-access-tokens", body, { approval })).status).toBe(403);
  });

  it("retains unresolved rotation ownership beyond expiry and never reopens a claim by age alone", async () => {
    const { row } = await f.seed();
    const now = new Date(f.now() - 48 * 3600_000).toISOString();
    const use = { jti: crypto.randomUUID(), consumedAt: now, expiresAt: now };
    expect(
      await f.repo.personalAccessTokens.claimRotation(
        row,
        {
          id: crypto.randomUUID(),
          candidateHash: "a".repeat(64),
          operationHash: "b".repeat(64),
          now,
        },
        use,
      ),
    ).toBe(true);
    expect(
      await f.repo.personalAccessTokens.purgeStepUpUses(new Date(f.now()).toISOString(), 100),
    ).toBe(0);
    expect(await f.repo.personalAccessTokens.hasPendingRotation(USER, row.id)).toBe(true);
    expect(
      await f.repo.personalAccessTokens.claimRotation(row, {
        id: crypto.randomUUID(),
        candidateHash: "c".repeat(64),
        operationHash: "d".repeat(64),
        now,
      }),
    ).toBe(false);
    expect((await f.repo.personalAccessTokens.getForUser(USER, row.id))?.tokenHash).toBe(
      row.tokenHash,
    );
    expect(f.puts).toEqual([]);
  });
});

async function scheduledRetention(now: number): Promise<void> {
  const waits: Promise<unknown>[] = [];
  runControlPlaneScheduled(
    { cron: "0 8 * * *", scheduledTime: now } as ScheduledController,
    {
      DB: f.bindings.d1,
      SESSION_STORE: f.bindings.kv,
      EVENT_INGEST_API: { adoptMetricEventClaimRetention: () => Promise.resolve() },
      TINYBIRD_API_URL: "https://api.tinybird.test",
      TINYBIRD_APPROVAL_ARCHIVE_WRITE_TOKEN: "fixture-write-token",
      PRIVACY_JOBS_QUEUE: { send: () => Promise.resolve() },
      PRIVACY_EXPORTS: {
        delete: () => Promise.resolve(),
        list: () => Promise.resolve({ objects: [], truncated: false, delimitedPrefixes: [] }),
      },
      SPLITCH_PLATFORM_TARGET: "local",
    } as unknown as ControlPlaneApiEnv,
    {
      waitUntil: (promise: Promise<unknown>) => waits.push(promise),
    } as unknown as ExecutionContext,
  );
  await Promise.all(waits);
}
