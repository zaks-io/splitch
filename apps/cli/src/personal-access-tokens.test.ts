import { chmod, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "./cli.js";
import { EXIT_OK, EXIT_USAGE } from "./exit-codes.js";
import { FakeCliTransport, type FakeResponse, storedCredential } from "./test-fixtures.js";
import { cleanupTempHomes, makeTempHome } from "./test-helpers.js";

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupTempHomes();
});

const SECRET = `spl_pat_${"9".repeat(64)}`;
const ROTATED_SECRET = `spl_pat_${"8".repeat(64)}`;
const TOKEN = {
  id: `pat_${"1".repeat(32)}`,
  name: "sandboxes",
  grants: [{ target: "all", role: "member", access: "read" }],
  expiresAt: null,
  neverExpires: true,
  status: "active",
  fingerprint: "abcdef012345",
  createdAt: "2026-10-03T00:00:00.000Z",
  lastRotatedAt: null,
  revokedAt: null,
};

const createResponse: FakeResponse = {
  match: (request) => request.method === "POST" && request.url.endsWith("/personal-access-tokens"),
  status: 200,
  body: { token: TOKEN, secret: SECRET },
};
const rotateResponse: FakeResponse = {
  match: (request) => request.url.endsWith(`/personal-access-tokens/${TOKEN.id}/rotate`),
  status: 200,
  body: { token: { ...TOKEN, lastRotatedAt: "2026-10-04T00:00:00.000Z" }, secret: ROTATED_SECRET },
};
const revokeResponse: FakeResponse = {
  match: (request) => request.url.endsWith(`/personal-access-tokens/${TOKEN.id}/revoke`),
  status: 200,
  body: { ...TOKEN, status: "revoked", revokedAt: "2026-10-04T00:00:00.000Z" },
};

async function run(args: string[], responses: FakeResponse[] = [createResponse]) {
  const { dir, credentialPath } = await makeTempHome();
  await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const transport = new FakeCliTransport(responses);
  const exitCode = await runCli([...args, "--json"], {
    cwd: dir,
    credentialPath,
    fetch: transport.fetch,
  });
  const output = [...log.mock.calls, ...error.mock.calls].flat().join("\n");
  return { dir, exitCode, output, log, transport };
}

const CREATE = ["tokens", "create", "--name", "sandboxes", "--grant", "all:member:read"];

describe("splitch tokens create", () => {
  it("writes the secret as an env line to a new 0600 file and never prints it", async () => {
    const { dir } = await makeTempHome();
    const target = join(dir, "mcp.env");
    const { exitCode, output, log, transport } = await run([
      ...CREATE,
      "--expires-at",
      "never",
      "--output-file",
      target,
    ]);

    expect(exitCode).toBe(EXIT_OK);
    expect(await readFile(target, "utf8")).toBe(`SPLITCH_MCP_TOKEN=${SECRET}\n`);
    expect((await stat(target)).mode & 0o777).toBe(0o600);
    expect(output).not.toContain(SECRET);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({
      token: { id: TOKEN.id, neverExpires: true },
      secret: null,
      secretWrittenTo: target,
      secretFormat: "env",
      envVar: "SPLITCH_MCP_TOKEN",
    });
    expect(transport.requests.at(-1)?.body).toEqual({
      name: "sandboxes",
      grants: [{ target: "all", role: "member", access: "read" }],
      expiresAt: null,
    });
  });

  it("appends to an existing env file without disturbing it", async () => {
    const { dir } = await makeTempHome();
    const target = join(dir, "sandbox.env");
    await writeFile(target, "OTHER=1\nLAST=no-newline", { mode: 0o600 });
    const { exitCode, output } = await run([...CREATE, "--output-file", target, "--append"]);
    expect(exitCode).toBe(EXIT_OK);
    expect(await readFile(target, "utf8")).toBe(
      `OTHER=1\nLAST=no-newline\nSPLITCH_MCP_TOKEN=${SECRET}\n`,
    );
    expect(output).not.toContain(SECRET);
  });

  it("creates the file when --append targets a missing path", async () => {
    const { dir } = await makeTempHome();
    const target = join(dir, "new.env");
    const { exitCode } = await run([
      ...CREATE,
      "--output-file",
      target,
      "--append",
      "--env-var",
      "MCP_PAT",
    ]);
    expect(exitCode).toBe(EXIT_OK);
    expect(await readFile(target, "utf8")).toBe(`MCP_PAT=${SECRET}\n`);
    expect((await stat(target)).mode & 0o777).toBe(0o600);
  });

  it("refuses unsafe or ambiguous targets before minting anything", async () => {
    const { dir } = await makeTempHome();
    const existing = join(dir, "existing.env");
    await writeFile(existing, "SPLITCH_MCP_TOKEN=old\n", { mode: 0o600 });
    const shared = join(dir, "shared.env");
    await writeFile(shared, "A=1\n");
    await chmod(shared, 0o644);

    for (const [extra, message] of [
      [[], /--output-file is required/],
      [["--output-file", "-"], /terminal or stream/],
      [["--output-file", existing], /already exists/],
      [["--output-file", existing, "--append"], /already defines SPLITCH_MCP_TOKEN/],
      [["--output-file", shared, "--append"], /readable by other users/],
      [
        ["--output-file", join(dir, "x"), "--append", "--secret-format", "raw"],
        /need --secret-format env/,
      ],
      [["--output-file", join(dir, "y"), "--env-var", "1BAD"], /not a valid variable name/],
    ] as const) {
      const { exitCode, output, transport } = await run([...CREATE, ...extra]);
      expect(exitCode, extra.join(" ")).toBe(EXIT_USAGE);
      expect(output).toMatch(message);
      expect(transport.requests).toHaveLength(0);
    }
  });

  it("rejects malformed grants and expiries before any request", async () => {
    const { dir } = await makeTempHome();
    for (const args of [
      [
        "tokens",
        "create",
        "--name",
        "x",
        "--grant",
        "app:app_1:admin",
        "--output-file",
        join(dir, "a"),
      ],
      [
        "tokens",
        "create",
        "--name",
        "x",
        "--grant",
        "all:superuser:read",
        "--output-file",
        join(dir, "b"),
      ],
      ["tokens", "create", "--name", "x", "--output-file", join(dir, "c")],
      [...CREATE, "--expires-at", "soon", "--output-file", join(dir, "d")],
    ]) {
      const { exitCode, transport } = await run(args);
      expect(exitCode, args.join(" ")).toBe(EXIT_USAGE);
      expect(transport.requests).toHaveLength(0);
    }
  });

  it("revokes the token when its secret cannot be written", async () => {
    const { dir } = await makeTempHome();
    const target = join(dir, "missing-dir", "mcp.env");
    const { exitCode, output, transport } = await run(
      [...CREATE, "--output-file", target],
      [createResponse, revokeResponse],
    );
    expect(exitCode).not.toBe(EXIT_OK);
    expect(output).toMatch(/unusable token was revoked/);
    expect(output).not.toContain(SECRET);
    expect(transport.requests.map((request) => request.url).at(-1)).toMatch(/\/revoke$/);
  });
});

describe("splitch tokens rotate / update", () => {
  it("rotates into an existing env file, replacing the variable in place with --force", async () => {
    const { dir } = await makeTempHome();
    const target = join(dir, "mcp.env");
    await writeFile(target, `A=1\nexport SPLITCH_MCP_TOKEN=${SECRET}\nB=2\n`, { mode: 0o600 });
    const { exitCode, output } = await run(
      ["tokens", "rotate", TOKEN.id, "--output-file", target, "--append", "--force"],
      [rotateResponse],
    );
    expect(exitCode).toBe(EXIT_OK);
    expect(await readFile(target, "utf8")).toBe(
      `A=1\nexport SPLITCH_MCP_TOKEN=${ROTATED_SECRET}\nB=2\n`,
    );
    expect((await stat(target)).mode & 0o777).toBe(0o600);
    expect(output).not.toContain(ROTATED_SECRET);
  });

  it("overwrites an existing file only with --force, leaving it 0600", async () => {
    const { dir } = await makeTempHome();
    const target = join(dir, "pat.txt");
    await writeFile(target, "old\n", { mode: 0o644 });
    const { exitCode } = await run([
      ...CREATE,
      "--output-file",
      target,
      "--secret-format",
      "raw",
      "--force",
    ]);
    expect(exitCode).toBe(EXIT_OK);
    expect(await readFile(target, "utf8")).toBe(`${SECRET}\n`);
    expect((await stat(target)).mode & 0o777).toBe(0o600);
  });

  it("sends replacement grants and a day-count expiry on update", async () => {
    const updateResponse: FakeResponse = {
      match: (request) => request.method === "PATCH",
      status: 200,
      body: TOKEN,
    };
    const { exitCode, transport } = await run(
      [
        "tokens",
        "update",
        TOKEN.id,
        "--grant",
        "app:app_1:admin:read-write",
        "--grant",
        "org:org_1:member:read",
        "--expires-at",
        "30d",
      ],
      [updateResponse],
    );
    expect(exitCode).toBe(EXIT_OK);
    const body = transport.requests.at(-1)?.body as { grants: unknown; expiresAt: string };
    expect(body.grants).toEqual([
      { target: "app:app_1", role: "admin", access: "read-write" },
      { target: "org:org_1", role: "member", access: "read" },
    ]);
    const days = (Date.parse(body.expiresAt) - Date.now()) / (24 * 60 * 60 * 1000);
    expect(Math.round(days)).toBe(30);
  });
});
