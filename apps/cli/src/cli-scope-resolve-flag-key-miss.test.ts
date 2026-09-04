import { writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "./cli.js";
import { EXIT_API } from "./exit-codes.js";
import { FakeCliTransport, jsonError, storedCredential } from "./test-fixtures.js";
import { cleanupTempHomes, makeTempHome } from "./test-helpers.js";

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupTempHomes();
});

describe("flags get missing server-side selectors", () => {
  it.each([
    { selector: "missing-banner", by: undefined },
    { selector: "flag_past_ceiling", by: "id" },
    { selector: "flag_missing_key", by: "key" },
  ])(
    "returns the server's FLAG_NOT_FOUND for $selector in one request",
    async ({ selector, by }) => {
      const { credentialPath } = await makeTempHome();
      await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`);
      const transport = new FakeCliTransport([
        {
          match: (request) => {
            const url = new URL(request.url);
            return (
              url.pathname === `/apps/app_1/flags/${selector}` &&
              url.searchParams.get("include") === "config" &&
              url.searchParams.get("by") === (by ?? null)
            );
          },
          status: 404,
          body: jsonError("FLAG_NOT_FOUND", "flag not found"),
        },
      ]);
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const args = ["flags", "get", "--json", "--app", "app_1", selector];
      if (by) args.push("--by", by);

      const code = await runCli(args, { credentialPath, fetch: transport.fetch });

      expect(code).toBe(EXIT_API);
      expect(error.mock.calls.join(" ")).toContain("FLAG_NOT_FOUND");
      expect(transport.requests).toHaveLength(1);
    },
  );
});
