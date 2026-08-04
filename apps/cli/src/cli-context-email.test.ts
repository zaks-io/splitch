import { readFile, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "./cli.js";
import { EXIT_OK } from "./exit-codes.js";
import { FakeCliTransport, oauthTokenMint, storedCredential } from "./test-fixtures.js";
import { cleanupTempHomes, makeTempHome } from "./test-helpers.js";

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupTempHomes();
});

describe("splitch context email backfill", () => {
  it("backfills email on context when a stored session still has the unknown placeholder", async () => {
    const { dir, credentialPath } = await makeTempHome();
    const legacy = {
      ...storedCredential(),
      principal: { userId: "user_test", email: "unknown" },
    };
    await writeFile(credentialPath, `${JSON.stringify(legacy)}\n`);
    const transport = new FakeCliTransport([oauthTokenMint()]);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const code = await runCli(["context", "--json"], {
      credentialPath,
      cwd: dir,
      fetch: transport.fetch,
    });

    expect(code).toBe(EXIT_OK);
    const payload = JSON.parse(log.mock.calls.join("")) as {
      principal: { userId: string; email: string };
    };
    expect(payload.principal).toEqual({
      userId: "user_test",
      email: "user_test@splitch.test",
    });
    const saved = JSON.parse(await readFile(credentialPath, "utf8")) as {
      principal: { email?: string };
    };
    expect(saved.principal.email).toBe("user_test@splitch.test");
    expect(JSON.stringify(saved)).not.toContain("unknown");
  });

  it("keeps context usable when email backfill refresh fails, and does not retry forever", async () => {
    const { dir, credentialPath } = await makeTempHome();
    const legacy = {
      ...storedCredential(),
      principal: { userId: "user_test" },
    };
    await writeFile(credentialPath, `${JSON.stringify(legacy)}\n`);
    const transport = new FakeCliTransport([
      {
        match: (request) => request.url.endsWith("/oauth2/token") && request.method === "POST",
        status: 500,
        body: { error: "server_error", error_description: "auth door fault" },
      },
    ]);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const first = await runCli(["context", "--json"], {
      credentialPath,
      cwd: dir,
      fetch: transport.fetch,
    });
    expect(first).toBe(EXIT_OK);
    const payload = JSON.parse(log.mock.calls.join("")) as {
      principal: { userId: string; email?: string };
    };
    expect(payload.principal).toEqual({ userId: "user_test" });

    log.mockClear();
    const second = await runCli(["context", "--json"], {
      credentialPath,
      cwd: dir,
      fetch: transport.fetch,
    });
    expect(second).toBe(EXIT_OK);
    expect(transport.requests.filter((r) => r.url.includes("/oauth2/token"))).toHaveLength(1);
    const saved = JSON.parse(await readFile(credentialPath, "utf8")) as {
      credential: { emailBackfillUnavailable?: boolean };
    };
    expect(saved.credential.emailBackfillUnavailable).toBe(true);
  });
});
