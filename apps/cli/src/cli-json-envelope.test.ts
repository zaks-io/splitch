import { writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "./cli.js";
import { EXIT_OK } from "./exit-codes.js";
import { flagsListStub, scopeResolutionStubs } from "./scope-resolution-fixtures.js";
import {
  FakeCliTransport,
  flagConfigResponse,
  flagListPage,
  flagRecord,
  storedCredential,
} from "./test-fixtures.js";
import { cleanupTempHomes, makeTempHome } from "./test-helpers.js";

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupTempHomes();
});

const FLAG_1 = [{ id: "flag_1", key: "flag-1", name: "Flag 1" }] as const;

async function jsonStdout(args: string[], transport: FakeCliTransport): Promise<unknown> {
  const { credentialPath } = await makeTempHome();
  await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    const code = await runCli(args, { credentialPath, fetch: transport.fetch });
    expect(code).toBe(EXIT_OK);
    const line = log.mock.calls.at(-1)?.[0];
    return JSON.parse(String(line));
  } finally {
    log.mockRestore();
  }
}

function objectKeys(value: unknown): string[] {
  return value && typeof value === "object" && !Array.isArray(value)
    ? Object.keys(value).sort()
    : [];
}

describe("CLI --json envelopes (SPL-451)", () => {
  it("flag-config get and update agree on the location of every shared field", async () => {
    const getTransport = new FakeCliTransport([
      ...scopeResolutionStubs(),
      flagsListStub({ flags: FLAG_1 }),
      {
        match: (request) => request.method === "GET" && request.url.includes("/config"),
        status: 200,
        body: flagConfigResponse,
      },
    ]);
    const updateTransport = new FakeCliTransport([
      ...scopeResolutionStubs(),
      flagsListStub({ flags: FLAG_1 }),
      {
        match: (request) => request.method === "PATCH" && request.url.includes("/config"),
        status: 200,
        body: { ...flagConfigResponse, approvalRequest: null },
      },
    ]);

    const got = await jsonStdout(
      ["flag-config", "get", "--json", "--app", "app_1", "--env", "env_1", "flag_1"],
      getTransport,
    );
    const updated = await jsonStdout(
      [
        "flag-config",
        "update",
        "--json",
        "--app",
        "app_1",
        "--env",
        "env_1",
        "flag_1",
        "--enabled",
        "true",
      ],
      updateTransport,
    );

    const getKeys = objectKeys(got);
    const sharedUpdateKeys = objectKeys(updated).filter((key) => key !== "approvalRequest");
    expect(getKeys.length).toBeGreaterThan(0);
    expect(sharedUpdateKeys).toEqual(getKeys);
    expect(got).toMatchObject({ enabled: true, targetingRules: [] });
    expect(updated).toMatchObject({ enabled: true, targetingRules: [], approvalRequest: null });
    expect(updated).not.toHaveProperty("config");
  });

  it("flag-targeting-rules replace keeps Flag Configuration fields at the get paths", async () => {
    const transport = new FakeCliTransport([
      ...scopeResolutionStubs(),
      flagsListStub({ flags: FLAG_1 }),
      {
        match: (request) => request.method === "PUT" && request.url.includes("/targeting-rules"),
        status: 200,
        body: { ...flagConfigResponse, approvalRequest: null },
      },
    ]);

    const replaced = await jsonStdout(
      [
        "flag-targeting-rules",
        "replace",
        "--json",
        "--app",
        "app_1",
        "--env",
        "env_1",
        "flag_1",
        "--body-json",
        JSON.stringify({ targetingRules: [] }),
      ],
      transport,
    );

    expect(objectKeys(replaced)).toEqual(
      [...Object.keys(flagConfigResponse), "approvalRequest"].sort(),
    );
    expect(replaced).toMatchObject({ enabled: true, targetingRules: [], approvalRequest: null });
    expect(replaced).not.toHaveProperty("config");
  });

  it.each([
    {
      args: ["flags", "list", "--json", "--app", "app_1"],
      body: flagListPage,
      match: (request: { url: string; method: string }) =>
        request.method === "GET" &&
        new URL(request.url).pathname === "/apps/app_1/flags" &&
        !new URL(request.url).searchParams.has("environmentId"),
    },
    {
      args: ["api-keys", "list", "--json", "--app", "app_1", "--env", "env_1"],
      body: { items: [], readLimit: 200, readTruncated: false, cursor: null },
      match: (request: { url: string; method: string }) =>
        request.method === "GET" && request.url.includes("/api-keys"),
    },
    {
      args: ["approval-requests", "list", "--json", "--app", "app_1"],
      body: {
        items: [],
        cursor: null,
        readLimit: 50,
        readTruncated: false,
      },
      match: (request: { url: string; method: string }) =>
        request.method === "GET" && request.url.includes("/approval-requests"),
    },
  ])("$args.0 $args.1 --json returns items, readLimit, and readTruncated", async (fixture) => {
    const transport = new FakeCliTransport([
      ...scopeResolutionStubs(),
      { match: fixture.match, status: 200, body: fixture.body },
    ]);
    const listed = await jsonStdout(fixture.args, transport);
    expect(listed).toMatchObject({
      items: expect.any(Array),
      readLimit: expect.any(Number),
      readTruncated: expect.any(Boolean),
    });
  });

  it("flags get stays a bare Flag (no resource wrapper)", async () => {
    const transport = new FakeCliTransport([
      ...scopeResolutionStubs(),
      flagsListStub({ flags: [{ id: flagRecord.id, key: flagRecord.key, name: flagRecord.name }] }),
      {
        match: (request) =>
          request.method === "GET" &&
          new URL(request.url).pathname === `/apps/app_1/flags/${flagRecord.id}`,
        status: 200,
        body: flagRecord,
      },
    ]);
    const got = await jsonStdout(
      ["flags", "get", "--json", "--app", "app_1", flagRecord.key],
      transport,
    );
    expect(got).toMatchObject({ id: flagRecord.id, key: flagRecord.key });
    expect(got).not.toHaveProperty("flag");
  });
});
