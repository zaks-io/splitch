import { writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "./cli.js";
import { EXIT_OK } from "./exit-codes.js";
import { scopeResolutionStubs } from "./scope-resolution-fixtures.js";
import { FakeCliTransport, flagConfigResponse, storedCredential } from "./test-fixtures.js";
import { cleanupTempHomes, makeTempHome } from "./test-helpers.js";

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupTempHomes();
});

function replaceOkStub() {
  return {
    match: (request: { method: string; url: string }) =>
      request.method === "PUT" && request.url.includes("/targeting-rules"),
    status: 200,
    body: { ...flagConfigResponse, approvalRequest: null },
  };
}

async function runAdd(args: readonly string[], transport: FakeCliTransport): Promise<number> {
  const { credentialPath } = await makeTempHome();
  await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`);
  return runCli(
    ["flag-targeting-rules", "add", "--json", "--app", "app_1", "--env", "env_1", ...args],
    { credentialPath, fetch: transport.fetch },
  );
}

function replaceRequest(transport: FakeCliTransport) {
  return transport.requests.find(
    (request) => request.method === "PUT" && request.url.includes("/targeting-rules"),
  );
}

function flagsGetStub(selector: string, body: unknown) {
  return {
    match: (request: { method: string; url: string }) => {
      const url = new URL(request.url);
      return request.method === "GET" && url.pathname === `/apps/app_1/flags/${selector}`;
    },
    status: 200,
    body,
  };
}

function flagCatalogBody(options: {
  readonly id: string;
  readonly key: string;
  readonly name: string;
}) {
  return {
    id: options.id,
    appId: "app_1",
    key: options.key,
    name: options.name,
    schema: { type: "boolean" },
    variants: [
      { id: "var_on", name: "on", value: true },
      { id: "var_off", name: "off", value: false },
    ],
    defaultVariantId: "var_off",
    createdAt: "2026-07-03T00:00:00.000Z",
    updatedAt: "2026-07-03T00:00:00.000Z",
  };
}

describe("flag-targeting-rules add server-side selector resolution", () => {
  it("keeps a Flag key unchanged across the read-modify-write", async () => {
    const transport = new FakeCliTransport([
      ...scopeResolutionStubs(),
      flagsGetStub(
        "past-ceiling-banner",
        flagCatalogBody({
          id: "flag_past_ceiling",
          key: "past-ceiling-banner",
          name: "Past ceiling",
        }),
      ),
      {
        match: (request) =>
          request.method === "GET" && request.url.includes("/flags/past-ceiling-banner/config"),
        status: 200,
        body: { ...flagConfigResponse, flagId: "flag_past_ceiling", targetingRules: [] },
      },
      replaceOkStub(),
    ]);

    expect(
      await runAdd(
        ["past-ceiling-banner", "--when", "plan=enterprise", "--serve", "on"],
        transport,
      ),
    ).toBe(EXIT_OK);

    const replace = replaceRequest(transport);
    expect(replace?.url).toContain("/flags/past-ceiling-banner/targeting-rules");
    expect(replace?.body).toMatchObject({
      targetingRules: [
        {
          flagId: "flag_past_ceiling",
          conditions: [{ attribute: "plan", operator: "eq", value: "enterprise" }],
          variantId: "var_on",
        },
      ],
    });
    expect(transport.requests.filter((request) => request.url.includes("/flags"))).toHaveLength(3);
  });

  it("uses the server's ID-first answer for a canonical-looking Flag selector", async () => {
    const transport = new FakeCliTransport([
      ...scopeResolutionStubs(),
      flagsGetStub(
        "flag_hidden_a",
        flagCatalogBody({ id: "flag_hidden_a", key: "hidden-a", name: "Hidden A" }),
      ),
      {
        match: (request) =>
          request.method === "GET" && request.url.includes("/flags/flag_hidden_a/config"),
        status: 200,
        body: { ...flagConfigResponse, flagId: "flag_hidden_a", targetingRules: [] },
      },
      replaceOkStub(),
    ]);

    const code = await runAdd(
      ["flag_hidden_a", "--when", "plan=enterprise", "--serve", "on"],
      transport,
    );

    expect(code).toBe(EXIT_OK);
    expect(replaceRequest(transport)?.url).toContain("/flags/flag_hidden_a/targeting-rules");
    expect(replaceRequest(transport)?.body).toMatchObject({
      targetingRules: [expect.objectContaining({ flagId: "flag_hidden_a" })],
    });
  });
});
