import { readFile } from "node:fs/promises";
import open from "open";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXIT_API, EXIT_OK } from "./exit-codes.js";
import {
  BROAD,
  CATALOG_READ,
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

describe("CLI Personal Access Token step-up", () => {
  it.each([
    ["all memberships", ["create", "--name", "x", "--grant", "all:member:read"]],
    ["out-of-scope target", ["create", "--name", "x", "--grant", "app:app_other:member:read"]],
    [
      "higher role",
      ["create", "--name", "x", "--grant", "app:app_1:owner:read"],
      ["app:app_1:member"],
    ],
    [
      "permanent issuance",
      ["create", "--name", "x", "--grant", "app:app_1:member:read", "--expires-at", "never"],
    ],
    ["adding a permission", ["update", TOKEN.id, "--grant", "app:app_1:member:write"]],
    ["newly permanent update", ["update", TOKEN.id, "--expires-at", "never"]],
  ])("approves %s before sending once with the original session", async (_name, args, scopes) => {
    const { result, requests, session } = await run(args, { scopes, pending: true });
    expect(result.exitCode).toBe(EXIT_OK);
    expect(open).toHaveBeenCalledOnce();
    const authRequests = requests.filter((request) => request.url.includes("/oauth2/"));
    expect(authRequests).toHaveLength(3);
    for (const request of authRequests) {
      expect(new URLSearchParams(await request.text()).get("authorization")).toBe("pat-management");
      expect(request.headers.get("Splitch-PAT-Authorization")).toBeNull();
    }
    const sent = mutations(requests);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.headers.get("authorization")).toBe(`Bearer ${session.credential.accessToken}`);
    expect(sent[0]?.headers.get("Splitch-PAT-Authorization")).toBe(STEP_UP);
    expect(requests.at(-1)).toBe(sent[0]);
  });

  it.each([
    ["finite create", ["create", "--name", "x", "--grant", "app:app_1:admin:write,delete"], TOKEN],
    ["within-scope update", ["update", TOKEN.id, "--name", "renamed"], TOKEN],
    [
      "narrowing a broad permanent token",
      ["update", TOKEN.id, "--grant", "app:app_other:member:read"],
      BROAD,
    ],
    ["shortening a broad permanent token", ["update", TOKEN.id, "--expires-at", "1d"], BROAD],
    ["within-scope rotation", ["rotate", TOKEN.id], TOKEN],
    ["list", ["list"], BROAD],
    ["revoke", ["revoke", TOKEN.id], BROAD],
    ["revoke-all", ["revoke-all"], BROAD],
  ])("keeps %s available without approval", async (_name, args, current) => {
    const { result, requests } = await run(args, { current });
    expect(result.exitCode).toBe(EXIT_OK);
    expect(open).not.toHaveBeenCalled();
    expect(requests.some((request) => request.url.includes("/oauth2/"))).toBe(false);
    expect(requests.every((request) => !request.headers.has("Splitch-PAT-Authorization"))).toBe(
      true,
    );
  });

  it("reads stored broad grants and permanent expiry before approving rotation", async () => {
    const { result, requests, outputFile } = await run(["rotate", TOKEN.id], { current: BROAD });
    expect(result.exitCode).toBe(EXIT_OK);
    expect(requests[0]?.method).toBe("GET");
    expect(requests[0]?.url).toMatch(/\/personal-access-tokens$/);
    expect(requests[0]?.headers.get("Splitch-PAT-Authorization")).toBeNull();
    expect(open).toHaveBeenCalledOnce();
    expect(mutations(requests)[0]?.headers.get("Splitch-PAT-Authorization")).toBe(STEP_UP);
    expect(await readFile(outputFile, "utf8")).toBe(`SPLITCH_TOKEN=${SECRET}\n`);
  });
});

describe("CLI Personal Access Token Organization coverage", () => {
  it("creates a finite App grant inside the session's Organization scope without approval", async () => {
    const { result, requests, session } = await run(
      ["create", "--name", "x", "--grant", "app:app_1:admin:write,delete"],
      { scopes: ["org:org_1:owner"] },
    );
    expect(result.exitCode).toBe(EXIT_OK);
    expect(open).not.toHaveBeenCalled();
    expect(requests[0]?.url).toMatch(/\/orgs\/org_1\/apps$/);
    expect(requests).toHaveLength(2);
    expect(mutations(requests)[0]?.headers.get("authorization")).toBe(
      `Bearer ${session.credential.accessToken}`,
    );
    expect(requests.every((request) => !request.headers.has("Splitch-PAT-Authorization"))).toBe(
      true,
    );
  });

  it("narrows a permanent Organization grant to its App using ordinary read rebinding", async () => {
    const { result, requests, session } = await run(
      ["update", TOKEN.id, "--grant", "app:app_1:member:read"],
      {
        current: {
          ...BROAD,
          grants: [{ target: "org:org_1", role: "owner", permissions: ["write"] }],
        },
        scopes: ["app:app_other:member"],
        catalogReadRebind: true,
      },
    );
    expect(result.exitCode).toBe(EXIT_OK);
    expect(open).not.toHaveBeenCalled();
    const catalog = requests.find((request) => request.url.endsWith("/orgs/org_1/apps"));
    expect(catalog?.headers.get("authorization")).toBe(`Bearer ${CATALOG_READ}`);
    expect(mutations(requests)[0]?.headers.get("authorization")).toBe(
      `Bearer ${session.credential.accessToken}`,
    );
    expect(requests.every((request) => !request.headers.has("Splitch-PAT-Authorization"))).toBe(
      true,
    );
  });

  it("propagates an App catalog lookup failure before browser approval or mutation", async () => {
    const { result, requests, output } = await run(
      ["create", "--name", "x", "--grant", "app:app_1:member:read"],
      { scopes: ["org:org_1:owner"], catalogFailure: true },
    );
    expect(result.exitCode).toBe(EXIT_API);
    expect(open).not.toHaveBeenCalled();
    expect(mutations(requests)).toHaveLength(0);
    expect(requests).toHaveLength(1);
    expect(output).toContain("App catalog unavailable");
  });
});

describe("CLI Personal Access Token approval output safety", () => {
  it("requires approval for adding permissions over a membership-wide read scope", async () => {
    const { result, requests } = await run(
      ["create", "--name", "x", "--grant", "app:app_1:member:write"],
      { authorization: "membership-wide-read" },
    );
    expect(result.exitCode).toBe(EXIT_OK);
    expect(open).toHaveBeenCalledOnce();
    expect(mutations(requests)[0]?.headers.get("Splitch-PAT-Authorization")).toBe(STEP_UP);
  });

  it("redacts approval echoed in successful metadata and keeps only the PAT in its output file", async () => {
    const { result, outputFile } = await run(
      ["create", "--name", "x", "--grant", "all:member:read"],
      { mutation: () => Response.json({ token: { ...TOKEN, name: STEP_UP }, secret: SECRET }) },
    );
    expect(result.exitCode).toBe(EXIT_OK);
    expect(await readFile(outputFile, "utf8")).toBe(`SPLITCH_TOKEN=${SECRET}\n`);
  });

  it.each(["response", "transport", "malformed"])(
    "redacts hostile %s failures and never retries a consumed approval",
    async (kind) => {
      const { result, requests, output } = await run(
        ["create", "--name", "x", "--grant", "all:member:read"],
        {
          mutation: () => {
            if (kind === "transport") throw new Error(`${STEP_UP} ${SECRET}`);
            if (kind === "malformed") return new Response(`${STEP_UP} ${SECRET}`, { status: 200 });
            return Response.json(
              { code: "UNAUTHORIZED", message: `${STEP_UP} ${SECRET}`, details: {} },
              { status: 401 },
            );
          },
        },
      );
      expect(result.exitCode).not.toBe(EXIT_OK);
      expect(mutations(requests)).toHaveLength(1);
      expect(output).toContain("[REDACTED]");
      expect(requests.filter((request) => request.url.endsWith("/oauth2/token"))).toHaveLength(1);
    },
  );

  it("redacts a hostile browser approval refusal and sends no mutation", async () => {
    const { result, requests } = await run(
      ["create", "--name", "x", "--grant", "all:member:read"],
      { approvalFailure: true },
    );
    expect(result.exitCode).not.toBe(EXIT_OK);
    expect(mutations(requests)).toHaveLength(0);
  });

  it("keeps token mode out of the approval and credential-store paths", async () => {
    const { result, requests } = await run(
      ["create", "--name", "x", "--grant", "all:member:read"],
      { tokenMode: true },
    );
    expect(result.exitCode).toBe(EXIT_API);
    expect(requests).toHaveLength(0);
    expect(open).not.toHaveBeenCalled();
  });
});
