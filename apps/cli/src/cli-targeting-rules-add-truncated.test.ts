import { writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "./cli.js";
import { EXIT_OK, EXIT_SCOPE } from "./exit-codes.js";
import { flagsListStub, scopeResolutionStubs } from "./scope-resolution-fixtures.js";
import {
  FakeCliTransport,
  flagConfigResponse,
  jsonError,
  storedCredential,
} from "./test-fixtures.js";
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

function flagsGetByStub(selector: string, by: "id" | "key", status: number, body: unknown) {
  return {
    match: (request: { method: string; url: string }) => {
      const url = new URL(request.url);
      return (
        request.method === "GET" &&
        url.pathname === `/apps/app_1/flags/${selector}` &&
        url.searchParams.get("by") === by
      );
    },
    status,
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

describe("flag-targeting-rules add past a truncated catalog", () => {
  it("resolves a Flag key beyond the flags_list page to the canonical ID", async () => {
    const transport = new FakeCliTransport([
      ...scopeResolutionStubs(),
      flagsListStub({
        flags: [{ id: "flag_other", key: "other-flag", name: "Other" }],
        readTruncated: true,
        readLimit: 200,
      }),
      flagsGetByStub(
        "past-ceiling-banner",
        "id",
        404,
        jsonError("FLAG_NOT_FOUND", "flag not found"),
      ),
      flagsGetByStub(
        "past-ceiling-banner",
        "key",
        200,
        flagCatalogBody({
          id: "flag_past_ceiling",
          key: "past-ceiling-banner",
          name: "Past ceiling",
        }),
      ),
      {
        match: (request) =>
          request.method === "GET" && request.url.includes("/flags/flag_past_ceiling/config"),
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
    expect(replace?.url).toContain("/flags/flag_past_ceiling/targeting-rules");
    expect(replace?.body).toMatchObject({
      targetingRules: [
        {
          flagId: "flag_past_ceiling",
          conditions: [{ attribute: "plan", operator: "eq", value: "enterprise" }],
          variantId: "var_on",
        },
      ],
    });
    expect(
      transport.requests.some(
        (request) =>
          request.method === "PUT" && request.url.includes("/flags/past-ceiling-banner/"),
      ),
    ).toBe(false);
  });

  it("refuses a visible key that collides with a hidden Flag ID past the ceiling", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const transport = new FakeCliTransport([
      ...scopeResolutionStubs(),
      flagsListStub({
        flags: [{ id: "flag_visible_b", key: "flag_hidden_a", name: "Visible B" }],
        readTruncated: true,
        readLimit: 200,
      }),
      flagsGetByStub(
        "flag_hidden_a",
        "id",
        200,
        flagCatalogBody({ id: "flag_hidden_a", key: "hidden-a", name: "Hidden A" }),
      ),
      flagsGetByStub(
        "flag_hidden_a",
        "key",
        200,
        flagCatalogBody({ id: "flag_visible_b", key: "flag_hidden_a", name: "Visible B" }),
      ),
      replaceOkStub(),
    ]);

    const code = await runAdd(
      ["flag_hidden_a", "--when", "plan=enterprise", "--serve", "on"],
      transport,
    );

    expect(code).toBe(EXIT_SCOPE);
    const message = error.mock.calls.join(" ");
    expect(message).toContain("CLI_SCOPE_UNRESOLVED");
    expect(message).toContain("flag_hidden_a");
    expect(message).toContain("flag_visible_b");
    expect(replaceRequest(transport)).toBeUndefined();
  });
});
