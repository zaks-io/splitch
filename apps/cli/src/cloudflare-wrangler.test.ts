import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { requireWrangler4, systemCommandRunner } from "./cloudflare-wrangler";
import type { CliCommandRunner } from "./execute-types";

// Fakes that guessed Wrangler's output let SPL-672 ship, so the version check
// runs the workspace's real Wrangler 4 through the real piped runner.
describe("requireWrangler4 against the real wrangler binary", () => {
  it("accepts the version real Wrangler 4 prints when piped", async () => {
    const calls: Array<readonly string[]> = [];
    const runner: CliCommandRunner = {
      run(command, args, options) {
        calls.push(args);
        if (args.includes("whoami"))
          return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
        return systemCommandRunner.run(command, args, options);
      },
    };

    await requireWrangler4(runner, dirname(fileURLToPath(import.meta.url)));

    expect(calls.at(-1)?.at(-1)).toBe("whoami");
  }, 30_000);
});
