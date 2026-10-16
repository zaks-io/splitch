import { personalAccessTokenCacheKey } from "@splitch/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runPersonalAccessTokenRetention } from "../src/personal-access-token-rotation";
import { makePersonalAccessTokenAuthorityResolver } from "../src/personal-access-token-store";
import { makeTokenMembershipAccess } from "../src/token-membership";
import { stepUpFixture, USER } from "./personal-access-token-step-up-fixture";

let f: Awaited<ReturnType<typeof stepUpFixture>>;
beforeEach(async () => {
  f = await stepUpFixture();
});
afterEach(async () => {
  await f.bindings.dispose();
});

describe("exclusive PAT rotation through real local D1", () => {
  it("a concurrent loser and a consumed-jti replay make zero KV calls and change no state", async () => {
    const { row } = await f.seed();
    const approval = await f.approval();
    let claimed!: () => void;
    const hasClaim = new Promise<void>((resolve) => {
      claimed = resolve;
    });
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tokens = f.repo.personalAccessTokens;
    f.rebuild({
      ...f.repo,
      personalAccessTokens: {
        ...tokens,
        claimRotation: async (...args) => {
          const accepted = await tokens.claimRotation(...args);
          if (accepted) {
            claimed();
            await released;
          }
          return accepted;
        },
      },
    });
    const path = `/personal-access-tokens/${row.id}/rotate`;
    const winner = f.call("POST", path, undefined, { approval });
    await hasClaim;
    const claims = await tokens.pendingRotations(new Date(f.now() + 1000).toISOString(), 100);
    expect(claims).toHaveLength(1);
    const claim = claims[0];
    if (!claim) throw new Error("missing real D1 claim");
    const oldCache = await f.bindings.kv.get(personalAccessTokenCacheKey(row.tokenHash));
    const candidateCache = await f.bindings.kv.get(
      personalAccessTokenCacheKey(claim.candidateHash),
    );
    expect((await f.call("POST", path, undefined, { approval })).status).toBe(403);
    expect(f.puts).toEqual([]);
    expect(await tokens.getForUser(USER, row.id)).toEqual(row);
    expect(await f.bindings.kv.get(personalAccessTokenCacheKey(row.tokenHash))).toEqual(oldCache);
    expect(await f.bindings.kv.get(personalAccessTokenCacheKey(claim.candidateHash))).toEqual(
      candidateCache,
    );
    release();
    expect((await winner).status).toBe(200);
    const after = await tokens.getForUser(USER, row.id);
    const oldAfter = await f.bindings.kv.get(personalAccessTokenCacheKey(row.tokenHash));
    const candidateAfter = await f.bindings.kv.get(
      personalAccessTokenCacheKey(claim.candidateHash),
    );
    expect(f.puts).toHaveLength(2);
    expect((await f.call("POST", path, undefined, { approval })).status).toBe(403);
    expect(f.puts).toHaveLength(2);
    expect(await tokens.getForUser(USER, row.id)).toEqual(after);
    expect(await f.bindings.kv.get(personalAccessTokenCacheKey(row.tokenHash))).toEqual(oldAfter);
    expect(await f.bindings.kv.get(personalAccessTokenCacheKey(claim.candidateHash))).toEqual(
      candidateAfter,
    );
  });

  it.each(["claim", "old KV write", "candidate KV write", "D1 swap"])(
    "failure after %s keeps durable ownership and reconciles fail closed",
    async (phase) => {
      const { row } = await f.seed();
      const tokens = f.repo.personalAccessTokens;
      if (phase === "claim")
        f.rebuild({
          ...f.repo,
          personalAccessTokens: {
            ...tokens,
            claimRotation: async (...args) => {
              const accepted = await tokens.claimRotation(...args);
              if (accepted) throw new Error("injected after durable claim");
              return accepted;
            },
          },
        });
      if (phase === "old KV write") f.setFailure(1);
      if (phase === "candidate KV write") f.setFailure(2);
      if (phase === "D1 swap")
        f.rebuild({
          ...f.repo,
          personalAccessTokens: {
            ...tokens,
            swapRotation: async (...args) => {
              await tokens.swapRotation(...args);
              throw new Error("injected after durable swap");
            },
          },
        });
      const approval = await f.approval();
      const path = `/personal-access-tokens/${row.id}/rotate`;
      const response = await f.call("POST", path, undefined, { approval });
      expect(response.status).toBe(500);
      expect(await response.text()).not.toMatch(/spl_pat_|eyJ/);
      const pending = await tokens.pendingRotations(new Date(f.now() + 1000).toISOString(), 100);
      expect(pending).toHaveLength(1);
      const claim = pending[0];
      if (!claim) throw new Error("missing pending operation");
      const beforeRetry = await tokens.getForUser(USER, row.id);
      const calls = f.puts.length;
      expect((await f.call("POST", path, undefined, { approval })).status).toBe(403);
      expect(f.puts).toHaveLength(calls);
      expect(await tokens.getForUser(USER, row.id)).toEqual(beforeRetry);
      const resolve = makePersonalAccessTokenAuthorityResolver({
        repo: f.repo,
        membershipAccess: makeTokenMembershipAccess(f.repo),
        nowMs: f.now,
      });
      for (const hash of [row.tokenHash, claim.candidateHash])
        expect(await resolve({ subject: USER, tokenId: row.id, tokenHash: hash })).toBeNull();
      f.setNow(f.now() + 301_000);
      await runPersonalAccessTokenRetention(tokens, f.bindings.kv, f.now());
      expect(await tokens.hasPendingRotation(USER, row.id)).toBe(false);
      expect((await tokens.getForUser(USER, row.id))?.revokedAt).not.toBeNull();
      for (const hash of [row.tokenHash, claim.candidateHash]) {
        const raw = await f.bindings.kv.get(personalAccessTokenCacheKey(hash));
        expect(JSON.parse(raw ?? "null")).toMatchObject({ revoked: true });
        expect(await resolve({ subject: USER, tokenId: row.id, tokenHash: hash })).toBeNull();
      }
      // Recovery keeps consumed approval durable, including after no active PAT remains.
      expect(
        (
          await f.bindings.d1
            .prepare("SELECT count(*) AS n FROM personal_access_token_step_up_uses")
            .first<{ n: number }>()
        )?.n,
      ).toBe(1);
    },
  );
});
