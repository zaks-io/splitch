import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "./cli.js";
import { EXIT_USAGE } from "./exit-codes.js";
import { parseInvocation } from "./parse-args.js";

/**
 * An unrecognised flag used to be collected into the flag bag and then dropped,
 * so `--org-id org_x` reached the API as a request missing its Organization and
 * came back as a schema violation pointing at the body. The typo has to be named
 * at the point the command rejects it.
 */
describe("unknown flags", () => {
  afterEach(() => vi.restoreAllMocks());

  it("rejects a near-miss flag by name instead of dropping it", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const fetch = vi.fn<typeof globalThis.fetch>();
    expect(await runCli(["apps", "create", "--org-id", "org_x", "--name", "App"], { fetch })).toBe(
      EXIT_USAGE,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("parses route query flags into the query bag before command validation", () => {
    const parsed = parseInvocation([
      "approval-requests",
      "list",
      "--cursor",
      "abc",
      "--limit",
      "10",
    ]);
    expect(parsed.flags.queryFlags).toEqual({ cursor: "abc", limit: "10" });
  });

  it("still accepts every flag the CLI reads, in kebab-case", () => {
    const parsed = parseInvocation([
      "flags",
      "create",
      "--app",
      "app_1",
      "--env",
      "prod",
      "--org",
      "org_1",
      "--endpoint",
      "https://cp.example",
      "--name",
      "Checkout",
      "--key",
      "checkout",
      "--targeting-key",
      "u1",
      "--id-type",
      "workspace",
      "--context-json",
      "{}",
      "--body-json",
      "{}",
      "--by",
      "id",
      "--variants",
      "on,off",
      "--from-environment-id",
      "env_1",
      "--enabled",
      "true",
      "--rollout",
      "10",
      "--idempotency-key",
      "idem-1",
      "--when",
      "plan=enterprise",
      "--serve",
      "on",
      "--json",
      "--confirm",
      "--summary",
    ]);

    expect(parsed.flags).toMatchObject({
      app: "app_1",
      env: "prod",
      org: "org_1",
      endpoint: "https://cp.example",
      name: "Checkout",
      key: "checkout",
      targetingKey: "u1",
      idType: "workspace",
      contextJson: "{}",
      bodyJson: "{}",
      by: "id",
      variants: "on,off",
      fromEnvironmentId: "env_1",
      enabled: true,
      rollout: 10,
      idempotencyKey: "idem-1",
      when: ["plan=enterprise"],
      serve: "on",
      json: true,
      confirm: true,
      summary: true,
      queryFlags: {},
    });
  });

  it("rejects the removed --with-config spelling instead of keeping a duplicate behavior", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const fetch = vi.fn<typeof globalThis.fetch>();
    expect(await runCli(["flags", "list", "--with-config", "1"], { fetch })).toBe(EXIT_USAGE);
    expect(fetch).not.toHaveBeenCalled();
  });
});
