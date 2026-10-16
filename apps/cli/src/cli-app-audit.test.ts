import { writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "./cli.js";
import { scopeResolutionStubs } from "./scope-resolution-fixtures.js";
import { FakeCliTransport, storedCredential } from "./test-fixtures.js";
import { cleanupTempHomes, makeTempHome } from "./test-helpers.js";

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupTempHomes();
});
describe("App audit CLI parity", () => {
  it("executes app-audit list through the Control Plane and keeps optional filters explicit", async () => {
    const { credentialPath } = await makeTempHome();
    await writeFile(credentialPath, JSON.stringify(storedCredential()));
    const transport = new FakeCliTransport([
      ...scopeResolutionStubs(),
      {
        match: (request) => new URL(request.url).pathname === "/apps/app_1/audit",
        status: 200,
        body: { items: [], readLimit: 2, readTruncated: false, cursor: null },
      },
    ]);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const code = await runCli(
      [
        "app-audit",
        "list",
        "--app",
        "app_1",
        "--limit",
        "2",
        "--run-id",
        "run_1",
        "--action",
        "runs_end",
        "--json",
      ],
      { credentialPath, fetch: transport.fetch },
    );
    expect(code).toBe(0);
    const request = transport.requests.find((item) =>
      new URL(item.url).pathname.endsWith("/audit"),
    );
    expect(request?.method).toBe("GET");
    expect(
      Object.fromEntries(new URL(request?.url ?? "https://missing.test").searchParams),
    ).toEqual({ limit: "2", runId: "run_1", action: "runs_end" });
  });
});
