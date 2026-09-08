import { describe, expect, it, vi } from "vitest";
import { runCli } from "./cli";
import { EXIT_USAGE } from "./exit-codes";

describe("CLI body input boundaries", () => {
  it("rejects a top-level __proto__ field before any request", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});

    const exitCode = await runCli(
      ["apps", "delete", "app_1", "--body-json", '{"__proto__":{"force":true}}'],
      { fetch },
    );

    expect(exitCode).toBe(EXIT_USAGE);
    expect(fetch).not.toHaveBeenCalled();
  });
});
