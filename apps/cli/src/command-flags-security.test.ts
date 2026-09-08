import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "./cli";
import { findCommand } from "./command-registry";
import { EXIT_USAGE } from "./exit-codes";
import { advertisedLongFlags, commandFlags } from "./help-flags";

afterEach(() => vi.restoreAllMocks());

describe("command-specific flags", () => {
  it.each(["--dry-run", "--force"])(
    "rejects %s on flags delete before any request",
    async (flag) => {
      const fetch = vi.fn<typeof globalThis.fetch>();
      vi.spyOn(console, "error").mockImplementation(() => {});
      vi.spyOn(console, "log").mockImplementation(() => {});

      expect(await runCli(["flags", "delete", "flag_1", flag], { fetch })).toBe(EXIT_USAGE);
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("rejects body JSON on a bodyless command", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await runCli(["flags", "list", "--body-json", "{}"], { fetch })).toBe(EXIT_USAGE);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects command flags on logout", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await runCli(["logout", "--app", "app_1"], { fetch })).toBe(EXIT_USAGE);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps delete controls on apps delete", () => {
    const command = findCommand(["apps", "delete"]);
    if (!command) throw new Error("apps delete command missing");
    expect([...advertisedLongFlags(commandFlags(command))]).toEqual(
      expect.arrayContaining(["--dry-run", "--force"]),
    );
  });
});
