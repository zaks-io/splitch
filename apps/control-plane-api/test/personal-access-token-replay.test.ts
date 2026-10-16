import { personalAccessTokenCacheKey } from "@splitch/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readGrant, stepUpFixture, USER } from "./personal-access-token-step-up-fixture";

let f: Awaited<ReturnType<typeof stepUpFixture>>;
beforeEach(async () => {
  f = await stepUpFixture();
});
afterEach(async () => {
  await f.bindings.dispose();
});

describe("verified approval replay through real D1", () => {
  it("refuses a widening update replay after the result becomes within session authority", async () => {
    const expiresAt = new Date(f.now() + 3600_000).toISOString();
    const { row } = await f.seed([readGrant], expiresAt);
    const approval = await f.approval();
    const body = { grants: [{ ...readGrant, permissions: ["write"] }], expiresAt };
    const path = `/personal-access-tokens/${row.id}`;
    expect((await f.call("PATCH", path, body, { approval })).status).toBe(200);
    const updated = await f.repo.personalAccessTokens.getForUser(USER, row.id);
    const cached = await f.bindings.kv.get(personalAccessTokenCacheKey(row.tokenHash));
    const writes = f.puts.length;

    expect((await f.call("PATCH", path, body, { approval })).status).toBe(403);
    expect(await f.repo.personalAccessTokens.getForUser(USER, row.id)).toEqual(updated);
    expect(await f.bindings.kv.get(personalAccessTokenCacheKey(row.tokenHash))).toEqual(cached);
    expect(f.puts).toHaveLength(writes);
    expect((await f.call("PATCH", path, { name: "header-free rename" })).status).toBe(200);
  });

  it("consumes a supplied approval on otherwise ordinary finite creation", async () => {
    const approval = await f.approval();
    const body = { name: "finite", grants: [readGrant] };
    expect((await f.call("POST", "/personal-access-tokens", body, { approval })).status).toBe(200);
    const before = await f.repo.personalAccessTokens.listForUser(USER, { limit: 100 });
    const writes = f.puts.length;
    expect((await f.call("POST", "/personal-access-tokens", body, { approval })).status).toBe(403);
    expect(await f.repo.personalAccessTokens.listForUser(USER, { limit: 100 })).toEqual(before);
    expect(f.puts).toHaveLength(writes);
  });
});
