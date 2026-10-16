import { PERSONAL_ACCESS_TOKEN_STEP_UP_CHALLENGE } from "@splitch/sdk/control-plane";
import open from "open";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXIT_OK } from "./exit-codes.js";
import {
  BROAD,
  personalAccessTokenMutations as mutations,
  runPersonalAccessTokenStepUp as run,
  SECRET,
  STEP_UP,
  TOKEN,
} from "./personal-access-token-test-fixtures.js";
import { cleanupTempHomes } from "./test-helpers.js";

vi.mock("open", () => ({ default: vi.fn() }));
beforeEach(() => {
  vi.mocked(open).mockReset();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupTempHomes();
});

const args = ["update", TOKEN.id, "--grant", "app:app_1:member:write,delete"];
const inconclusive = {
  current: {
    ...BROAD,
    grants: [{ target: "org:org_1", role: "owner" as const, permissions: ["write" as const] }],
  },
  scopes: ["app:app_other:member"],
  appFailures: { app_1: 403 as const },
  catalogReadRebind: true,
};
function challenge(): Response {
  return Response.json(
    { code: "FORBIDDEN", message: "approve in the browser", details: {} },
    { status: 403, headers: { "WWW-Authenticate": PERSONAL_ACCESS_TOKEN_STEP_UP_CHALLENGE } },
  );
}

function optimisticResponse(kind: string): Response {
  const headers = { "WWW-Authenticate": PERSONAL_ACCESS_TOKEN_STEP_UP_CHALLENGE };
  switch (kind) {
    case "transport":
      throw new Error(`${STEP_UP} ${SECRET}`);
    case "malformed":
      return new Response(`${STEP_UP} ${SECRET}`, { status: 403, headers });
    case "success with challenge":
      return Response.json(TOKEN, { headers });
    default:
      return Response.json(
        { code: "FORBIDDEN", message: "unrecognized", details: {} },
        {
          status: 403,
          headers: { "WWW-Authenticate": 'Bearer error="invalid_token"' },
        },
      );
  }
}

describe("CLI inconclusive PAT challenge", () => {
  it("sends unapproved first, then approves and sends once with the original session", async () => {
    let count = 0;
    const { result, requests, session } = await run(args, {
      ...inconclusive,
      mutation: () => (++count === 1 ? challenge() : Response.json(TOKEN)),
    });
    expect(result.exitCode).toBe(EXIT_OK);
    expect(open).toHaveBeenCalledOnce();
    const sent = mutations(requests);
    expect(sent).toHaveLength(2);
    expect(sent.map((request) => request.headers.get("Splitch-PAT-Authorization"))).toEqual([
      null,
      STEP_UP,
    ]);
    expect(sent.map((request) => request.headers.get("authorization"))).toEqual([
      `Bearer ${session.credential.accessToken}`,
      `Bearer ${session.credential.accessToken}`,
    ]);
    expect(await sent[0]?.text()).toBe(await sent[1]?.text());
    expect(requests.findIndex((request) => request.method === "PATCH")).toBeLessThan(
      requests.findIndex((request) => request.url.endsWith("/oauth2/device_authorization")),
    );
  });

  it("sends only the marked refused request when approval is denied", async () => {
    const { result, requests } = await run(args, {
      ...inconclusive,
      mutation: challenge,
      approvalFailure: true,
    });
    expect(result.exitCode).not.toBe(EXIT_OK);
    expect(open).toHaveBeenCalledOnce();
    expect(mutations(requests)).toHaveLength(1);
    expect(mutations(requests)[0]?.headers.has("Splitch-PAT-Authorization")).toBe(false);
  });

  it.each([
    [400, "VALIDATION_ERROR", { issues: [{ path: ["grants"], message: "invalid" }] }],
    [404, "CREDENTIAL_NOT_FOUND", {}],
    [403, "FORBIDDEN", {}],
    [401, "UNAUTHORIZED", {}],
  ])("returns unmarked %s %s without approval or retry", async (status, code, details) => {
    const { result, requests, output } = await run(args, {
      ...inconclusive,
      mutation: () => Response.json({ code, message: "original refusal", details }, { status }),
    });
    expect(result.exitCode).not.toBe(EXIT_OK);
    expect(output).toContain("original refusal");
    expect(open).not.toHaveBeenCalled();
    expect(mutations(requests)).toHaveLength(1);
  });

  it.each(["transport", "malformed", "unrecognized challenge", "success with challenge"])(
    "never repeats the optimistic request after %s",
    async (kind) => {
      const { result, requests } = await run(args, {
        ...inconclusive,
        mutation: () => optimisticResponse(kind),
      });
      expect(result.exitCode === EXIT_OK).toBe(kind === "success with challenge");
      expect(open).not.toHaveBeenCalled();
      expect(mutations(requests)).toHaveLength(1);
    },
  );

  it.each(["challenge", "other refusal", "transport", "malformed"])(
    "makes the second %s final, without a third request or second approval",
    async (kind) => {
      let count = 0;
      const { result, requests } = await run(args, {
        ...inconclusive,
        mutation: () => {
          if (++count === 1 || kind === "challenge") return challenge();
          if (kind === "transport") throw new Error(`${STEP_UP} ${SECRET}`);
          if (kind === "malformed") return new Response(`${STEP_UP} ${SECRET}`, { status: 200 });
          return Response.json(
            { code: "FORBIDDEN", message: "final refusal", details: {} },
            { status: 403 },
          );
        },
      });
      expect(result.exitCode).not.toBe(EXIT_OK);
      expect(open).toHaveBeenCalledOnce();
      expect(mutations(requests)).toHaveLength(2);
      expect(
        requests.filter((request) => request.url.endsWith("/oauth2/device_authorization")),
      ).toHaveLength(1);
    },
  );
});
