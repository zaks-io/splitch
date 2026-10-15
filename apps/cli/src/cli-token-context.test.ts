import { readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { personalAccessTokenPermissions } from "@splitch/sdk/control-plane";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "./cli.js";
import { executeInvocation } from "./execute.js";
import { EXIT_OK, EXIT_USAGE } from "./exit-codes.js";
import { parseInvocation } from "./parse-args.js";
import { cleanupTempHomes, makeTempHome } from "./test-helpers.js";

const secret = `spl_pat_${"b".repeat(64)}`;
const token = {
  id: `pat_${"c".repeat(32)}`,
  name: "sandbox",
  grants: [{ target: "app:app_1", role: "admin", permissions: ["write"] }],
  expiresAt: null,
  effective: {
    scopes: ["app:app_1:member"],
    permissions: Object.fromEntries(
      personalAccessTokenPermissions.map((permission) => [
        permission,
        { scopes: permission === "write" ? ["app:app_1:member"] : [], all: false },
      ]),
    ),
  },
};
const capabilities = {
  scopes: token.effective.scopes,
  membershipWideRead: false,
  personalAccessToken: { id: token.id, permissions: token.effective.permissions },
  token,
};
const servers: Server[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeAllConnections();
        }),
    ),
  );
  await cleanupTempHomes();
});

function unusedStore() {
  const fail = async () => {
    throw new Error("Token mode called the credential store");
  };
  return { load: vi.fn(fail), save: vi.fn(fail), clear: vi.fn(fail) };
}

describe("CLI token context", () => {
  it("calls the live endpoint and lists Apps from a clean credential path", async () => {
    const { dir, credentialPath } = await makeTempHome();
    const requests: { path: string; authorized: boolean }[] = [];
    const server = createServer((request, response) => {
      requests.push({
        path: request.url ?? "",
        authorized: request.headers.authorization === `Bearer ${secret}`,
      });
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify(
          request.url === "/principal/capabilities"
            ? capabilities
            : { items: [], readLimit: 200, readTruncated: false, cursor: null },
        ),
      );
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected a local TCP server");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const options = {
      cwd: dir,
      credentialPath,
      env: { SPLITCH_TOKEN: secret },
      platformTarget: "local",
      controlPlaneBaseUrl: `http://127.0.0.1:${address.port}`,
    };

    expect(await runCli(["context", "--json"], options)).toBe(EXIT_OK);
    const context = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(context).toMatchObject({
      authenticated: true,
      credentialMode: "token",
      personalAccessToken: token,
    });
    expect(context.principal).toBeUndefined();
    expect(context.nextSteps).toContain("splitch orgs list");
    expect(await runCli(["apps", "list", "--org", "org_1", "--json"], options)).toBe(EXIT_OK);
    expect(requests).toEqual([
      { path: "/principal/capabilities", authorized: true },
      { path: "/orgs/org_1/apps", authorized: true },
    ]);
    await expect(readFile(credentialPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect([...log.mock.calls, ...error.mock.calls].flat().join("\n")).not.toContain("spl_pat_");
  });

  it("reports configured and effective authority separately without touching a store", async () => {
    const { dir } = await makeTempHome();
    const credentialStore = unusedStore();
    const stdout: string[] = [];
    const stderr: string[] = [];
    const result = await executeInvocation(
      parseInvocation(["context", "--app", "app_1", "--env", "dev", "--json"]),
      {
        cwd: dir,
        credentialStore,
        env: { SPLITCH_TOKEN: secret },
        io: { log: (line) => stdout.push(line), error: (line) => stderr.push(line) },
        fetch: async () => Response.json(capabilities),
      },
    );

    expect(result.exitCode).toBe(EXIT_OK);
    expect(JSON.parse(stdout.join(""))).toMatchObject({
      credentialMode: "token",
      appId: "app_1",
      environmentId: "dev",
      personalAccessToken: {
        grants: [{ role: "admin" }],
        effective: { scopes: ["app:app_1:member"] },
      },
    });
    for (const method of Object.values(credentialStore)) expect(method).not.toHaveBeenCalled();
    expect([...stdout, ...stderr].join("\n")).not.toContain("spl_pat_");
  });

  it("fails loudly when token metadata is missing", async () => {
    const { dir, credentialPath } = await makeTempHome();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(
      await runCli(["context", "--json"], {
        cwd: dir,
        credentialPath,
        env: { SPLITCH_TOKEN: secret },
        fetch: async () => Response.json({ scopes: [], membershipWideRead: false }),
      }),
    ).toBe(EXIT_USAGE);
    expect(JSON.parse(String(log.mock.calls[0]?.[0])).code).toBe("CLI_UNEXPECTED_ERROR");
  });

  it("clears a deleted App's project selection without loading session credentials", async () => {
    const { dir } = await makeTempHome();
    await writeFile(join(dir, "splitch.json"), JSON.stringify({ version: 1, app: "app_1" }));
    const credentialStore = unusedStore();
    const result = await executeInvocation(
      parseInvocation(["apps", "delete", "--app", "app_1", "--json"]),
      {
        cwd: dir,
        credentialStore,
        env: { SPLITCH_TOKEN: secret },
        io: { log: () => {}, error: () => {} },
        fetch: async () => Response.json({ deleted: true }),
      },
    );
    expect(result.exitCode).toBe(EXIT_OK);
    await expect(readFile(join(dir, "splitch.json"))).rejects.toMatchObject({ code: "ENOENT" });
    for (const method of Object.values(credentialStore)) expect(method).not.toHaveBeenCalled();
  });
});

describe("CLI token owner cleanup", () => {
  it("allows owner cleanup with an App-only read token", async () => {
    const { dir } = await makeTempHome();
    const credentialStore = unusedStore();
    const stdout: string[] = [];
    const stderr: string[] = [];
    const record = {
      ...token,
      grants: [{ target: "app:app_1", role: "member", permissions: [] }],
      neverExpires: true,
      status: "active",
      fingerprint: "123456789abc",
      createdAt: "2026-10-03T00:00:00.000Z",
      lastRotatedAt: null,
      revokedAt: null,
    };
    const deps = {
      cwd: dir,
      credentialStore,
      env: { SPLITCH_TOKEN: secret },
      io: { log: (line: string) => stdout.push(line), error: (line: string) => stderr.push(line) },
      fetch: vi.fn(async (input: RequestInfo | URL) => {
        const request = input as Request;
        const body = request.url.endsWith("/revoke")
          ? { ...record, status: "revoked", revokedAt: "2026-10-15T00:00:00.000Z" }
          : { items: [record], readLimit: 200, readTruncated: false, cursor: null };
        return Response.json(body);
      }),
    };
    expect(
      (await executeInvocation(parseInvocation(["tokens", "list", "--json"]), deps)).exitCode,
    ).toBe(EXIT_OK);
    expect(
      (await executeInvocation(parseInvocation(["tokens", "revoke", token.id, "--json"]), deps))
        .exitCode,
    ).toBe(EXIT_OK);
    expect(deps.fetch).toHaveBeenCalledTimes(2);
    for (const method of Object.values(credentialStore)) expect(method).not.toHaveBeenCalled();
    expect([...stdout, ...stderr].join("\n")).not.toContain("spl_pat_");
  });
});
