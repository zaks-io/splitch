import { writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "./cli.js";
import { EXIT_OK, EXIT_USAGE } from "./exit-codes.js";
import { renderCommandHelp, renderHelp } from "./help.js";
import { findCommand } from "./command-registry.js";
import { flagsListStub, scopeResolutionStubs } from "./scope-resolution-fixtures.js";
import { FakeCliTransport, flagConfigResponse, storedCredential } from "./test-fixtures.js";
import { cleanupTempHomes, makeTempHome } from "./test-helpers.js";

afterEach(async () => {
  await cleanupTempHomes();
});

const FLAG_1 = [{ id: "flag_1", key: "flag-1", name: "Flag 1" }];
const EXISTING_RULE = {
  id: "rule_old",
  flagId: "flag_1",
  priority: 0,
  conditions: [{ attribute: "plan", operator: "eq", value: "free" }],
  variantId: "var_off",
  percentageRollout: null,
};

function flagsGetStub() {
  const variants = [
    { id: "var_on", name: "on", value: true },
    { id: "var_off", name: "off", value: false },
  ];
  return {
    match: (request: { method: string; url: string }) =>
      request.method === "GET" && new URL(request.url).pathname === "/apps/app_1/flags/flag_1",
    status: 200,
    body: {
      id: "flag_1",
      appId: "app_1",
      key: "flag-1",
      name: "Flag 1",
      schema: { type: "boolean" },
      variants,
      defaultVariantId: "var_off",
      createdAt: "2026-07-03T00:00:00.000Z",
      updatedAt: "2026-07-03T00:00:00.000Z",
    },
  };
}

function flagConfigGetStub(targetingRules: readonly unknown[] = []) {
  return {
    match: (request: { method: string; url: string }) =>
      request.method === "GET" && request.url.includes("/flags/flag_1/config"),
    status: 200,
    body: { ...flagConfigResponse, targetingRules },
  };
}

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

describe("flag-targeting-rules add (SPL-405)", () => {
  it("appends one equality rule on a clean Flag", async () => {
    const transport = new FakeCliTransport([
      ...scopeResolutionStubs(),
      flagsListStub({ flags: FLAG_1 }),
      flagsGetStub(),
      flagConfigGetStub([]),
      replaceOkStub(),
    ]);

    expect(await runAdd(["flag_1", "--when", "plan=enterprise", "--serve", "on"], transport)).toBe(
      EXIT_OK,
    );

    const replace = transport.requests.find(
      (request) => request.method === "PUT" && request.url.includes("/targeting-rules"),
    );
    expect(replace?.body).toEqual({
      targetingRules: [
        {
          id: expect.stringMatching(/^rule_[0-9a-f]{32}$/),
          flagId: "flag_1",
          priority: 0,
          conditions: [{ attribute: "plan", operator: "eq", value: "enterprise" }],
          variantId: "var_on",
          percentageRollout: null,
        },
      ],
      idempotency_key: expect.any(String),
    });
  });

  it("preserves existing rules and AND-combines repeatable --when", async () => {
    const transport = new FakeCliTransport([
      ...scopeResolutionStubs(),
      flagsListStub({ flags: FLAG_1 }),
      flagsGetStub(),
      flagConfigGetStub([EXISTING_RULE]),
      replaceOkStub(),
    ]);

    expect(
      await runAdd(
        ["flag_1", "--when", "plan=enterprise", "--when", "beta=true", "--serve", "on"],
        transport,
      ),
    ).toBe(EXIT_OK);

    const replace = transport.requests.find(
      (request) => request.method === "PUT" && request.url.includes("/targeting-rules"),
    );
    expect(replace?.body).toMatchObject({
      targetingRules: [
        EXISTING_RULE,
        {
          flagId: "flag_1",
          priority: 1,
          conditions: [
            { attribute: "plan", operator: "eq", value: "enterprise" },
            { attribute: "beta", operator: "eq", value: "true" },
          ],
          variantId: "var_on",
        },
      ],
    });
  });

  it("fails loud on an unknown Variant before any replace write", async () => {
    const transport = new FakeCliTransport([
      ...scopeResolutionStubs(),
      flagsListStub({ flags: FLAG_1 }),
      flagsGetStub(),
      {
        match: (request) => request.method === "PUT" && request.url.includes("/targeting-rules"),
        status: 500,
        body: { code: "INTERNAL_ERROR", message: "must not write" },
      },
    ]);

    const code = await runAdd(
      ["flag_1", "--when", "plan=enterprise", "--serve", "maybe"],
      transport,
    );
    expect(code).toBe(EXIT_USAGE);
    expect(
      transport.requests.some(
        (request) => request.method === "PUT" && request.url.includes("/targeting-rules"),
      ),
    ).toBe(false);
  });

  it("fails loud on malformed --when before any API call", async () => {
    const transport = new FakeCliTransport([]);
    const { credentialPath } = await makeTempHome();
    await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`);
    const code = await runCli(
      [
        "flag-targeting-rules",
        "add",
        "--json",
        "--app",
        "app_1",
        "--env",
        "env_1",
        "flag_1",
        "--when",
        "plan",
        "--serve",
        "on",
      ],
      { credentialPath, fetch: transport.fetch },
    );
    expect(code).toBe(EXIT_USAGE);
    expect(transport.requests).toEqual([]);
  });

  it("fails loud when --serve is missing before any API call", async () => {
    const transport = new FakeCliTransport([]);
    expect(await runAdd(["flag_1", "--when", "plan=enterprise"], transport)).toBe(EXIT_USAGE);
    expect(transport.requests).toEqual([]);
  });

  it("cross-links add and replace in help", () => {
    const add = findCommand(["flag-targeting-rules", "add"]);
    const replace = findCommand(["flag-targeting-rules", "replace"]);
    expect(add).toBeDefined();
    expect(replace).toBeDefined();
    if (!add || !replace) return;

    const addHelp = renderCommandHelp(add);
    expect(addHelp).toContain("--when <attr=value>");
    expect(addHelp).toContain("--serve <variant>");
    expect(addHelp).toContain("flag-targeting-rules replace");
    expect(addHelp).toContain("last-write-wins");
    expect(addHelp).toContain("Object.is");
    expect(addHelp).not.toContain("Request body (--body-json):");

    const replaceHelp = renderCommandHelp(replace);
    expect(replaceHelp).toContain("flag-targeting-rules add --when attr=value --serve <variant>");
    expect(replaceHelp).toContain("last-write-wins");

    const group = renderHelp(["flag-targeting-rules", "--help"]);
    expect(group).toContain("add");
    expect(group).toContain("replace");
  });
});
