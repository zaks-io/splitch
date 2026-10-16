import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { personalAccessTokenPermissions } from "@splitch/sdk/control-plane";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeInvocation } from "./execute.js";
import { EXIT_API, EXIT_AUTH, EXIT_OK } from "./exit-codes.js";
import { parseInvocation } from "./parse-args.js";
import { storedCredential } from "./test-fixtures.js";
import { cleanupTempHomes, makeTempHome } from "./test-helpers.js";

const secret = `spl_pat_${"d".repeat(64)}`;
const token = {
  id: `pat_${"e".repeat(32)}`,
  name: "snapshot",
  grants: [{ target: "org:org_1", role: "member", permissions: [] }],
  expiresAt: null,
  effective: {
    scopes: ["org:org_1:member"],
    permissions: Object.fromEntries(
      personalAccessTokenPermissions.map((permission) => [permission, { scopes: [], all: false }]),
    ),
  },
};
const page = { items: [], readLimit: 200, readTruncated: false, cursor: null };

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupTempHomes();
});

function unusedStore() {
  const fail = async () => {
    throw new Error("Token mode called the credential store");
  };
  return { load: vi.fn(fail), save: vi.fn(fail), clear: vi.fn(fail) };
}

function captureOutput() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    io: { log: (line: string) => stdout.push(line), error: (line: string) => stderr.push(line) },
    assertSecretAbsent() {
      expect([...stdout, ...stderr].join("\n")).not.toContain("spl_pat_");
    },
  };
}

describe("CLI invocation credential snapshot", () => {
  it.each([
    { args: ["context", "--json"], path: "/principal/capabilities" },
    { args: ["apps", "list", "--org", "org_1", "--json"], path: "/orgs/org_1/apps" },
  ])(
    "reads a changing getter once for $path and sends the original PAT",
    async ({ args, path }) => {
      const { dir } = await makeTempHome();
      const readToken = vi.fn<() => string | undefined>().mockReturnValueOnce(secret);
      const credentialStore = unusedStore();
      const output = captureOutput();
      const requests: { path: string; authorized: boolean }[] = [];
      const result = await executeInvocation(parseInvocation(args), {
        cwd: dir,
        credentialStore,
        env: {
          get SPLITCH_TOKEN() {
            return readToken();
          },
        },
        io: output.io,
        fetch: async (input) => {
          const request = input as Request;
          requests.push({
            path: new URL(request.url).pathname,
            authorized: request.headers.get("authorization") === `Bearer ${secret}`,
          });
          return Response.json(
            path === "/principal/capabilities"
              ? { scopes: [], membershipWideRead: false, token }
              : page,
          );
        },
      });
      expect(result.exitCode).toBe(EXIT_OK);
      expect(readToken).toHaveBeenCalledTimes(1);
      expect(requests).toEqual([{ path, authorized: true }]);
      for (const method of Object.values(credentialStore)) expect(method).not.toHaveBeenCalled();
      output.assertSecretAbsent();
    },
  );

  it.each([
    { status: 401, code: "UNAUTHORIZED", expectedCode: "CLI_TOKEN_INVALID", exitCode: EXIT_AUTH },
    {
      status: 403,
      code: "CREDENTIAL_REVOKED",
      expectedCode: "CLI_TOKEN_INVALID",
      exitCode: EXIT_AUTH,
    },
    { status: 403, code: "FORBIDDEN", expectedCode: "FORBIDDEN", exitCode: EXIT_API },
  ])("preserves token mapping for $status $code after async env mutation", async (response) => {
    const { dir } = await makeTempHome();
    let current: string | undefined = secret;
    const readToken = vi.fn(() => current);
    const credentialStore = unusedStore();
    const output = captureOutput();
    const authorized: boolean[] = [];
    const pending = executeInvocation(
      parseInvocation(["apps", "list", "--org", "org_1", "--json"]),
      {
        cwd: dir,
        credentialStore,
        env: {
          get SPLITCH_TOKEN() {
            return readToken();
          },
        },
        io: output.io,
        fetch: async (input) => {
          authorized.push((input as Request).headers.get("authorization") === `Bearer ${secret}`);
          return Response.json(
            { code: response.code, message: "Refused", details: {} },
            { status: response.status },
          );
        },
      },
    );
    await Promise.resolve();
    current = undefined;
    expect((await pending).exitCode).toBe(response.exitCode);
    expect(JSON.parse(output.stdout.join("")).code).toBe(response.expectedCode);
    expect(readToken).toHaveBeenCalledTimes(1);
    expect(authorized).toEqual([true]);
    for (const method of Object.values(credentialStore)) expect(method).not.toHaveBeenCalled();
    output.assertSecretAbsent();
  });

  it("refuses session-only commands using the initial token selection", async () => {
    const { dir } = await makeTempHome();
    const readToken = vi.fn<() => string | undefined>().mockReturnValueOnce(secret);
    const credentialStore = unusedStore();
    const output = captureOutput();
    const result = await executeInvocation(
      parseInvocation(["tokens", "update", token.id, "--name", "renamed", "--json"]),
      {
        cwd: dir,
        credentialStore,
        env: {
          get SPLITCH_TOKEN() {
            return readToken();
          },
        },
        io: output.io,
        fetch: async () => {
          throw new Error("Session-only command made a network request");
        },
      },
    );
    expect(result.exitCode).toBe(EXIT_API);
    expect(JSON.parse(output.stdout.join("")).code).toBe("FORBIDDEN");
    expect(readToken).toHaveBeenCalledTimes(1);
    for (const method of Object.values(credentialStore)) expect(method).not.toHaveBeenCalled();
    output.assertSecretAbsent();
  });
});

describe("CLI credential snapshot after async work", () => {
  it("keeps an initially unset credential in session mode after env injection", async () => {
    const { dir } = await makeTempHome();
    let current: string | undefined;
    const readToken = vi.fn(() => current);
    const session = storedCredential();
    const credentialStore = {
      load: vi.fn(async () => {
        current = secret;
        await Promise.resolve();
        return {
          ...session,
          credential: { ...session.credential, accessTokenBinding: "org:org_1" },
        };
      }),
      save: vi.fn(),
      clear: vi.fn(),
    };
    const output = captureOutput();
    const authorized: boolean[] = [];
    const result = await executeInvocation(
      parseInvocation(["apps", "list", "--org", "org_1", "--json"]),
      {
        cwd: dir,
        credentialStore,
        env: {
          get SPLITCH_TOKEN() {
            return readToken();
          },
        },
        io: output.io,
        fetch: async (input) => {
          authorized.push(
            (input as Request).headers.get("authorization") ===
              `Bearer ${session.credential.accessToken}`,
          );
          return Response.json(
            { code: "CREDENTIAL_REVOKED", message: "Refused", details: {} },
            { status: 403 },
          );
        },
      },
    );
    expect(result.exitCode).toBe(EXIT_API);
    expect(JSON.parse(output.stdout.join("")).code).toBe("CREDENTIAL_REVOKED");
    expect(readToken).toHaveBeenCalledTimes(1);
    expect(credentialStore.load).toHaveBeenCalledTimes(1);
    expect(credentialStore.save).not.toHaveBeenCalled();
    expect(credentialStore.clear).not.toHaveBeenCalled();
    expect(authorized).toEqual([true]);
    output.assertSecretAbsent();
  });

  it("keeps token mode during App deletion cleanup after the environment changes", async () => {
    const { dir } = await makeTempHome();
    const configPath = join(dir, "splitch.json");
    await writeFile(configPath, JSON.stringify({ version: 1, app: "app_1" }));
    let current: string | undefined = secret;
    const readToken = vi.fn(() => current);
    const credentialStore = unusedStore();
    const output = captureOutput();
    const result = await executeInvocation(
      parseInvocation(["apps", "delete", "--app", "app_1", "--json"]),
      {
        cwd: dir,
        credentialStore,
        env: {
          get SPLITCH_TOKEN() {
            return readToken();
          },
        },
        io: output.io,
        fetch: async () => {
          current = undefined;
          return Response.json({ deleted: true });
        },
      },
    );
    expect(result.exitCode).toBe(EXIT_OK);
    expect(readToken).toHaveBeenCalledTimes(1);
    await expect(readFile(configPath)).rejects.toMatchObject({ code: "ENOENT" });
    for (const method of Object.values(credentialStore)) expect(method).not.toHaveBeenCalled();
    output.assertSecretAbsent();
  });
});
