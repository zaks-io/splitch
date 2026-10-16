import { PERSONAL_ACCESS_TOKEN_STEP_UP_CHALLENGE } from "@splitch/contracts";
import open from "open";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callPersonalAccessTokenMutation } from "../../cli/src/personal-access-token-step-up";
import {
  APP,
  ORG,
  OTHER_APP,
  readGrant,
  stepUpFixture,
  USER,
} from "./personal-access-token-step-up-fixture";

vi.mock("open", () => ({ default: vi.fn() }));
let f: Awaited<ReturnType<typeof stepUpFixture>>;
let output: unknown[];
let secrets: string[];
beforeEach(async () => {
  // Node's CLI uses redirect:error. workerd only implements manual, and this
  // in-process Hono transport never follows a redirect or leaves the fixture.
  const EdgeRequest = Request;
  vi.stubGlobal(
    "Request",
    class extends EdgeRequest {
      constructor(input: RequestInfo | URL, init?: RequestInit) {
        super(input, init?.redirect === "error" ? { ...init, redirect: "manual" } : init);
      }
    },
  );
  f = await stepUpFixture();
  output = [];
  secrets = [];
  vi.mocked(open).mockReset();
  for (const method of ["log", "error", "warn", "info", "debug"] as const)
    vi.spyOn(console, method).mockImplementation((...args) => {
      output.push(args);
    });
});
afterEach(async () => {
  for (const secret of secrets)
    expect(JSON.stringify([...output, ...f.events])).not.toContain(secret);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await f.bindings.dispose();
});

async function cli(
  options: {
    removed?: boolean;
    refuseApproval?: boolean;
    lookupFailure?: boolean;
    revokeBeforeMutation?: boolean;
    failAfterMutation?: boolean;
  } = {},
) {
  const { row, secret } = await f.seed(
    [{ target: `org:${ORG}`, role: "owner", permissions: ["write"] }],
    new Date(f.now() + 3600_000).toISOString(),
  );
  if (options.removed) {
    await f.bindings.d1.prepare("DELETE FROM org_memberships WHERE org_id = ?").bind(ORG).run();
    await f.bindings.d1.prepare("DELETE FROM app_memberships WHERE app_id = ?").bind(APP).run();
  }
  const session = await f.jwt({ scopes: [`app:${OTHER_APP}:member`] });
  const read = await f.jwt({ scopes: [], authorization: "membership-wide-read" });
  const approval = await f.approval();
  secrets.push(secret, session, read, approval);
  const credentialStore = {
    load: vi.fn(async () => ({
      version: 1 as const,
      principal: { userId: USER, email: "fixture@splitch.test" },
      credential: {
        type: "device_flow" as const,
        accessToken: read,
        refreshToken: "fixture-refresh",
        accessTokenBinding: "membership-wide-read",
        accessTokenExpiresAt: new Date(f.now() + 3600_000).toISOString(),
      },
    })),
    save: vi.fn(),
    clear: vi.fn(),
  };
  const requests: Request[] = [];
  const responses: Response[] = [];
  const deps = {
    env: {},
    credentialStore,
    sleep: async () => {},
    io: { log: (line: string) => output.push(line), error: (line: string) => output.push(line) },
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      if (path.startsWith("/apps/") && options.lookupFailure) throw new Error("lookup unavailable");
      if (path === "/oauth2/device_authorization")
        return Response.json({
          device_code: "fixture-device",
          user_code: "ABCD-1234",
          verification_uri: "https://auth.splitch.dev/device",
          interval: 0,
        });
      if (path === "/oauth2/token")
        return options.refuseApproval
          ? Response.json({ error: "access_denied" }, { status: 400 })
          : Response.json({ access_token: approval, expires_in: 300 });
      if (request.method === "PATCH" && options.revokeBeforeMutation)
        await f.repo.personalAccessTokens.revoke(USER, row.id, new Date(f.now()).toISOString());
      const response = await f.app().request(request);
      if (request.method === "PATCH") {
        requests.push(request);
        responses.push(response.clone());
        if (options.failAfterMutation) throw new Error("connection lost after server committed");
      }
      return response;
    }) as typeof fetch,
  };
  return {
    row,
    requests,
    responses,
    credentialStore,
    session,
    approval,
    run: (body: Record<string, unknown>) =>
      callPersonalAccessTokenMutation(
        "personal_access_tokens_update",
        { tokenId: row.id, ...body },
        `Bearer ${session}`,
        deps,
      ),
  };
}

describe("CLI challenge against real D1 routes", () => {
  it("never retries or opens approval after losing a successful cleanup response", async () => {
    const c = await cli({ removed: true, failAfterMutation: true });
    await expect(c.run({ grants: [readGrant] })).rejects.toThrow("connection lost");
    expect(c.requests).toHaveLength(1);
    expect(c.responses[0]?.status).toBe(200);
    expect(open).not.toHaveBeenCalled();
    expect(await f.repo.personalAccessTokens.getForUser(USER, c.row.id)).toMatchObject({
      grants: JSON.stringify([readGrant]),
      tokenHash: c.row.tokenHash,
    });
  });

  it("narrows an unreadable removed Organization to its App without opening approval", async () => {
    const c = await cli({ removed: true });
    const grants = [readGrant];
    expect(
      (
        await f.call("GET", `/apps/${APP}`, undefined, {
          claims: { scopes: [], authorization: "membership-wide-read" },
        })
      ).status,
    ).toBe(403);
    expect((await c.run({ grants })).ok).toBe(true);
    expect(open).not.toHaveBeenCalled();
    expect(c.requests).toHaveLength(1);
    expect(c.requests[0]?.headers.has("Splitch-PAT-Authorization")).toBe(false);
    expect(await f.repo.personalAccessTokens.getForUser(USER, c.row.id)).toMatchObject({
      grants: JSON.stringify(grants),
      expiresAt: c.row.expiresAt,
      tokenHash: c.row.tokenHash,
    });
    expect(c.credentialStore.save).not.toHaveBeenCalled();
  });

  it("retries an inconclusive widening exactly once after approval and stores it once", async () => {
    const c = await cli({ lookupFailure: true });
    const grants = [{ ...readGrant, permissions: ["write", "delete"] }];
    expect((await c.run({ grants })).ok).toBe(true);
    expect(c.requests).toHaveLength(2);
    expect(open).toHaveBeenCalledOnce();
    expect(c.responses.map((response) => response.status)).toEqual([403, 200]);
    expect(c.responses[0]?.headers.get("WWW-Authenticate")).toBe(
      PERSONAL_ACCESS_TOKEN_STEP_UP_CHALLENGE,
    );
    expect(c.requests.map((request) => request.headers.get("authorization"))).toEqual([
      `Bearer ${c.session}`,
      `Bearer ${c.session}`,
    ]);
    expect(c.requests[0]?.headers.has("Splitch-PAT-Authorization")).toBe(false);
    expect(c.requests[1]?.headers.get("Splitch-PAT-Authorization")).toBe(c.approval);
    expect(await f.repo.personalAccessTokens.getForUser(USER, c.row.id)).toMatchObject({
      grants: JSON.stringify(grants),
      tokenHash: c.row.tokenHash,
    });
    expect(
      (
        await f.bindings.d1
          .prepare("SELECT count(*) AS n FROM personal_access_token_step_up_uses")
          .first<{ n: number }>()
      )?.n,
    ).toBe(1);
    expect(c.credentialStore.save).not.toHaveBeenCalled();
  });

  it.each(["validation", "not found"])(
    "returns the real optimistic %s refusal without approval",
    async (kind) => {
      const c = await cli({ removed: true, revokeBeforeMutation: kind === "not found" });
      const result = await c.run({
        grants: [readGrant],
        ...(kind === "validation" ? { expiresAt: new Date(f.now() - 1000).toISOString() } : {}),
      });
      expect(result.ok).toBe(false);
      expect(result.status).toBe(kind === "validation" ? 400 : 404);
      expect(c.requests).toHaveLength(1);
      expect(c.responses[0]?.headers.has("WWW-Authenticate")).toBe(false);
      expect(open).not.toHaveBeenCalled();
      expect(f.puts).toEqual([]);
      expect(await f.repo.personalAccessTokens.getForUser(USER, c.row.id)).toMatchObject({
        grants: c.row.grants,
        tokenHash: c.row.tokenHash,
        expiresAt: c.row.expiresAt,
      });
    },
  );

  it.each([false, true])(
    "challenges an inconclusive widening; approval refused = %s",
    async (refuseApproval) => {
      // The unreadable App's membership is gone. Widening to permanent still
      // requires approval; issuance membership validation remains authoritative.
      const c = await cli({ removed: true, refuseApproval });
      const run = c.run({ grants: [readGrant], expiresAt: null });
      if (refuseApproval) await expect(run).rejects.toThrow();
      else expect((await run).ok).toBe(false);
      expect(c.requests).toHaveLength(refuseApproval ? 1 : 2);
      expect(open).toHaveBeenCalledOnce();
      expect(c.responses[0]?.status).toBe(403);
      expect(c.responses[0]?.headers.get("WWW-Authenticate")).toBe(
        PERSONAL_ACCESS_TOKEN_STEP_UP_CHALLENGE,
      );
      expect(c.requests[0]?.headers.has("Splitch-PAT-Authorization")).toBe(false);
      if (!refuseApproval) {
        expect(c.requests[1]?.headers.get("Splitch-PAT-Authorization")).toBe(c.approval);
        expect(c.responses[1]?.status).toBe(400);
        expect(c.responses[1]?.headers.has("WWW-Authenticate")).toBe(false);
      }
      expect(await f.repo.personalAccessTokens.getForUser(USER, c.row.id)).toEqual(c.row);
      expect(f.puts).toEqual([]);
      expect(c.credentialStore.save).not.toHaveBeenCalled();
    },
  );
});
