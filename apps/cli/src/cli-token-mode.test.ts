import { readFile, stat, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withAuthorizationRetry } from "./auth.js";
import { runCli } from "./cli.js";
import { executeInvocation } from "./execute.js";
import { executeApiOperation } from "./execute-operations.js";
import { EXIT_API, EXIT_AUTH, EXIT_USAGE } from "./exit-codes.js";
import { parseInvocation } from "./parse-args.js";
import { FakeCliTransport, jsonError, storedCredential } from "./test-fixtures.js";
import { cleanupTempHomes, makeTempHome } from "./test-helpers.js";

const secret = `spl_pat_${"a".repeat(64)}`;

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupTempHomes();
});

function untouchedStore() {
  const unexpected = async () => {
    throw new Error("Token mode touched the credential store");
  };
  return { load: vi.fn(unexpected), save: vi.fn(unexpected), clear: vi.fn(unexpected) };
}

function captureOutput() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: { log: (line: string) => stdout.push(line), error: (line: string) => stderr.push(line) },
    assertSecretAbsent() {
      expect([...stdout, ...stderr].join("\n")).not.toContain("spl_pat_");
    },
  };
}

describe("CLI Personal Access Token credentials", () => {
  it("uses only the env credential for bound and membership-wide operations", async () => {
    const credentialStore = untouchedStore();
    const run = vi.fn(async (authorization: string) => {
      expect(authorization === `Bearer ${secret}`).toBe(true);
      return { status: 200, value: "ok" };
    });
    const deps = { credentialStore, env: { SPLITCH_TOKEN: secret } };

    await expect(
      withAuthorizationRetry(deps, run, { kind: "app", selector: "app_other" }),
    ).resolves.toBe("ok");
    await expect(withAuthorizationRetry(deps, run, { kind: "membership-wide-read" })).resolves.toBe(
      "ok",
    );
    for (const method of Object.values(credentialStore)) expect(method).not.toHaveBeenCalled();
  });

  it.each([
    "",
    " ",
    "bad",
    `spl_pat_${"A".repeat(64)}`,
    `spl_pat_${"a".repeat(63)}`,
    `${secret}\n`,
    ` ${secret}`,
  ])("refuses a malformed env credential before any request or store call (%#)", async (value) => {
    const credentialStore = untouchedStore();
    const run = vi.fn();
    await expect(
      withAuthorizationRetry({ credentialStore, env: { SPLITCH_TOKEN: value } }, run),
    ).rejects.toMatchObject({ code: "CLI_TOKEN_INVALID" });
    expect(run).not.toHaveBeenCalled();
    for (const method of Object.values(credentialStore)) expect(method).not.toHaveBeenCalled();
  });

  it("uses the ambient environment when no env override is supplied", async () => {
    vi.stubEnv("SPLITCH_TOKEN", secret);
    const credentialStore = untouchedStore();
    try {
      await expect(
        withAuthorizationRetry({ credentialStore }, async (authorization) => ({
          status: 200,
          value: authorization === `Bearer ${secret}`,
        })),
      ).resolves.toBe(true);
      expect(credentialStore.load).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each(["login", "logout"])(
    "refuses %s with zero store calls even for an empty value",
    async (command) => {
      const credentialStore = untouchedStore();
      const fetchImpl = vi.fn();
      await expect(
        executeInvocation(parseInvocation([command]), {
          credentialStore,
          fetch: fetchImpl,
          env: { SPLITCH_TOKEN: "" },
        }),
      ).rejects.toMatchObject({
        code: "CLI_USAGE_INVALID",
        message: expect.stringContaining("SPLITCH_TOKEN"),
      });
      expect(fetchImpl).not.toHaveBeenCalled();
      for (const method of Object.values(credentialStore)) expect(method).not.toHaveBeenCalled();
    },
  );

  it.each(["login", "logout"])(
    "leaves the credential file contents and permissions unchanged on %s",
    async (command) => {
      const { dir, credentialPath } = await makeTempHome();
      const contents = `${JSON.stringify(storedCredential())}\n`;
      await writeFile(credentialPath, contents, { mode: 0o640 });
      const before = await stat(credentialPath);
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const fetchImpl = vi.fn();

      expect(
        await runCli([command, "--json"], {
          cwd: dir,
          credentialPath,
          fetch: fetchImpl,
          env: { SPLITCH_TOKEN: secret },
        }),
      ).toBe(EXIT_USAGE);
      expect(await readFile(credentialPath, "utf8")).toBe(contents);
      expect((await stat(credentialPath)).mode).toBe(before.mode);
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(error.mock.calls.flat().join("\n")).toContain("Unset SPLITCH_TOKEN");
      expect([...log.mock.calls, ...error.mock.calls].flat().join("\n")).not.toContain("spl_pat_");
    },
  );

  it.each(["context", "health"])(
    "rejects an empty credential before %s can make a request",
    async (command) => {
      const { dir, credentialPath } = await makeTempHome();
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const fetchImpl = vi.fn();
      expect(
        await runCli([command, "--json"], {
          cwd: dir,
          credentialPath,
          fetch: fetchImpl,
          env: { SPLITCH_TOKEN: "" },
        }),
      ).toBe(EXIT_AUTH);
      expect(JSON.parse(String(log.mock.calls[0]?.[0])).code).toBe("CLI_TOKEN_INVALID");
      expect(fetchImpl).not.toHaveBeenCalled();
      expect([...log.mock.calls, ...error.mock.calls].flat().join("\n")).not.toContain("spl_pat_");
    },
  );
});

describe("CLI token refusals", () => {
  it.each([
    [401, "UNAUTHORIZED", "CLI_TOKEN_INVALID", EXIT_AUTH],
    [403, "CREDENTIAL_REVOKED", "CLI_TOKEN_INVALID", EXIT_AUTH],
    [400, "CREDENTIAL_REVOKED", "CREDENTIAL_REVOKED", EXIT_API],
    [403, "FORBIDDEN", "FORBIDDEN", EXIT_API],
  ] as const)(
    "classifies HTTP %i %s without session refresh",
    async (status, code, expected, exitCode) => {
      const { dir } = await makeTempHome();
      const credentialStore = untouchedStore();
      const output = captureOutput();
      const transport = new FakeCliTransport([
        {
          match: () => true,
          status,
          body: jsonError(code, "Missing credentials permission or live membership"),
        },
      ]);
      const result = await executeInvocation(
        parseInvocation(["apps", "list", "--org", "org_1", "--json"]),
        {
          cwd: dir,
          credentialStore,
          io: output.io,
          fetch: transport.fetch,
          env: { SPLITCH_TOKEN: secret },
        },
      );

      expect(result.exitCode).toBe(exitCode);
      expect(JSON.parse(output.stdout.join("")).code).toBe(expected);
      if (code === "FORBIDDEN") expect(output.stderr.join("")).toContain("credentials");
      expect(transport.requests).toHaveLength(1);
      for (const method of Object.values(credentialStore)) expect(method).not.toHaveBeenCalled();
      output.assertSecretAbsent();
    },
  );

  it("classifies a 401 with no structured body as CLI_TOKEN_INVALID", async () => {
    const { dir, credentialPath } = await makeTempHome();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(
      await runCli(["apps", "list", "--org", "org_1", "--json"], {
        cwd: dir,
        credentialPath,
        env: { SPLITCH_TOKEN: secret },
        fetch: async () => new Response("Unauthorized", { status: 401 }),
      }),
    ).toBe(EXIT_AUTH);
    expect(JSON.parse(String(log.mock.calls[0]?.[0])).code).toBe("CLI_TOKEN_INVALID");
  });

  it.each([
    "personal_access_tokens_create",
    "personal_access_tokens_update",
    "personal_access_tokens_rotate",
    "current_user_delete",
  ])("gives session login remediation for %s", async (operationId) => {
    const output = captureOutput();
    const fetchImpl = vi.fn();
    const result = await executeApiOperation(
      operationId,
      {},
      parseInvocation(["tokens", "list", "--json"]),
      { credentialStore: untouchedStore(), fetch: fetchImpl, env: { SPLITCH_TOKEN: secret } },
      { ...output.io, json: true },
    );
    expect(result.exitCode).toBe(EXIT_API);
    const failure = JSON.parse(output.stdout.join(""));
    expect(failure.code).toBe("FORBIDDEN");
    expect(failure.remediation).toContain("Unset SPLITCH_TOKEN and run splitch login");
    expect(fetchImpl).not.toHaveBeenCalled();
    output.assertSecretAbsent();
  });

  it("redacts secrets echoed in server errors and details from both output streams", async () => {
    const { dir } = await makeTempHome();
    const output = captureOutput();
    const result = await executeInvocation(
      parseInvocation(["apps", "list", "--org", "org_1", "--json"]),
      {
        cwd: dir,
        credentialStore: untouchedStore(),
        env: { SPLITCH_TOKEN: secret },
        io: output.io,
        fetch: async () =>
          Response.json(
            {
              code: "VALIDATION_ERROR",
              message: `Refused ${secret}`,
              details: { issues: [{ path: ["credential"], message: secret }] },
            },
            { status: 400 },
          ),
      },
    );
    expect(result.exitCode).toBe(EXIT_API);
    expect(output.stdout.join("")).toContain("[REDACTED]");
    output.assertSecretAbsent();
  });

  it("redacts a transport error from both output streams", async () => {
    const { dir } = await makeTempHome();
    const output = captureOutput();
    const result = await executeInvocation(
      parseInvocation(["apps", "list", "--org", "org_1", "--json"]),
      {
        cwd: dir,
        credentialStore: untouchedStore(),
        env: { SPLITCH_TOKEN: secret },
        io: output.io,
        fetch: async () => {
          throw new Error(`Failed ${secret}`);
        },
      },
    );
    expect(result.exitCode).toBe(EXIT_USAGE);
    output.assertSecretAbsent();
  });
});
