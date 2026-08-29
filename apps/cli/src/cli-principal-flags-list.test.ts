import { writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "./cli.js";
import { EXIT_OK } from "./exit-codes.js";
import { FakeCliTransport, storedCredential } from "./test-fixtures.js";
import { cleanupTempHomes, makeTempHome } from "./test-helpers.js";

const timestamp = "2026-08-28T00:00:00.000Z";
const principalPage = {
  readTruncated: false,
  readLimit: 200,
  cursor: null,
  items: [
    principalFlag("org_alpha", "alpha", "app_checkout", "checkout", "flag_tax", "sales-tax"),
    principalFlag("org_alpha", "alpha", "app_search", "search", "flag_rank", "ranking"),
    principalFlag("org_beta", "beta", "app_billing", "billing", "flag_invoice", "invoice"),
  ],
};

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupTempHomes();
});

describe("scope-free flags list", () => {
  it("makes one GET /flags request and preserves the wire envelope in JSON mode", async () => {
    const scope = await unscopedSession();
    const transport = transportFor(principalPage);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const code = await runCli(["flags", "list", "--json"], {
      ...scope,
      cwd: scope.dir,
      fetch: transport.fetch,
    });

    expect(code).toBe(EXIT_OK);
    expect(JSON.parse(log.mock.calls.join(""))).toEqual(principalPage);
    const apiRequests = transport.requests.filter(
      (request) => request.method === "GET" && new URL(request.url).pathname === "/flags",
    );
    expect(apiRequests).toHaveLength(1);
    expect(transport.requests.some((request) => request.url.includes("/apps/"))).toBe(false);
  });

  it("temporarily refreshes wide authority for a login with a saved App", async () => {
    const scope = await selectedAppSession();
    const transport = transportFor(principalPage);

    expect(
      await runCli(["flags", "list", "--json"], {
        ...scope,
        cwd: scope.dir,
        fetch: transport.fetch,
      }),
    ).toBe(EXIT_OK);

    const refresh = transport.requests.find((request) => request.url.endsWith("/oauth2/token"));
    expect(refresh?.body).toMatchObject({ authorization: "membership-wide-read" });
    expect(refresh?.body).not.toHaveProperty("app");
    expect(
      transport.requests.filter(
        (request) => request.method === "GET" && new URL(request.url).pathname === "/flags",
      ),
    ).toHaveLength(1);
  });

  it("groups human output by App with selector and canonical id", async () => {
    const scope = await unscopedSession();
    const transport = transportFor(principalPage);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    expect(
      await runCli(["flags", "list"], { ...scope, cwd: scope.dir, fetch: transport.fetch }),
    ).toBe(EXIT_OK);

    const human = log.mock.calls.join("\n");
    expect(human).toContain('"app": "alpha/checkout"');
    expect(human).toContain('"id": "app_checkout"');
    expect(human).toContain('"app": "beta/billing"');
    expect(human).toContain('"key": "invoice"');
  });

  it("requests hydration without inventing an App or Environment filter", async () => {
    const scope = await unscopedSession();
    const transport = transportFor(principalPage);

    expect(
      await runCli(["flags", "list", "--with-config", "--json"], {
        ...scope,
        cwd: scope.dir,
        fetch: transport.fetch,
      }),
    ).toBe(EXIT_OK);

    const request = transport.requests.find(
      (candidate) => candidate.method === "GET" && new URL(candidate.url).pathname === "/flags",
    );
    expect(new URL(request?.url ?? "https://invalid").searchParams.get("include")).toBe("config");
    expect(new URL(request?.url ?? "https://invalid").searchParams.has("envs")).toBe(false);
  });

  it("tells a human how to narrow an incomplete cross-App result", async () => {
    const scope = await unscopedSession();
    const transport = transportFor({ ...principalPage, readTruncated: true });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(
      await runCli(["flags", "list"], { ...scope, cwd: scope.dir, fetch: transport.fetch }),
    ).toBe(EXIT_OK);
    expect(error.mock.calls.join("\n")).toContain("Narrow it with --app <app>");
  });
});

async function unscopedSession() {
  const home = await makeTempHome();
  const stored = storedCredential();
  const { selectedAppId: _selectedAppId, ...credential } = stored.credential;
  await writeFile(
    home.credentialPath,
    `${JSON.stringify({ ...stored, credential: { ...credential, accessTokenBinding: "" } })}\n`,
  );
  return home;
}

async function selectedAppSession() {
  const home = await makeTempHome();
  await writeFile(home.credentialPath, `${JSON.stringify(storedCredential())}\n`);
  return home;
}

function transportFor(body: unknown): FakeCliTransport {
  return new FakeCliTransport([
    {
      match: (request) => request.url.endsWith("/oauth2/token") && request.method === "POST",
      status: 200,
      body: {
        access_token: "wide-access-token",
        refresh_token: "fixture-refresh-token",
        token_type: "Bearer",
        expires_in: 3600,
        authorization: "membership-wide-read",
      },
    },
    {
      match: (request) => new URL(request.url).pathname === "/flags",
      status: 200,
      body,
    },
  ]);
}

function principalFlag(
  orgId: string,
  orgSlug: string,
  appId: string,
  appKey: string,
  flagId: string,
  flagKey: string,
) {
  return {
    id: flagId,
    appId,
    key: flagKey,
    name: flagKey,
    schema: null,
    variants: [{ id: `var_${flagId}`, name: "control", value: false }],
    defaultVariantId: `var_${flagId}`,
    createdAt: timestamp,
    updatedAt: timestamp,
    org: { id: orgId, slug: orgSlug },
    app: { id: appId, key: appKey },
  };
}
