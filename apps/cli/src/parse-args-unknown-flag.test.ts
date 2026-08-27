import { describe, expect, it } from "vitest";
import { SplitchCliError } from "./errors.js";
import { parseInvocation } from "./parse-args.js";

/**
 * An unrecognised flag used to be collected into the flag bag and then dropped,
 * so `--org-id org_x` reached the API as a request missing its Organization and
 * came back as a schema violation pointing at the body. The typo has to be named
 * at the point it was typed.
 */
describe("unknown flags", () => {
  it("rejects a near-miss flag by name instead of dropping it", () => {
    try {
      parseInvocation(["apps", "create", "--org-id", "org_x"]);
      throw new Error("expected an unknown flag to fail parsing");
    } catch (error) {
      expect(error).toBeInstanceOf(SplitchCliError);
      expect(error).toMatchObject({ code: "CLI_USAGE_INVALID" });
      expect((error as SplitchCliError).message).toContain("--org-id");
    }
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
      "--context-json",
      "{}",
      "--body-json",
      "{}",
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
    ]);

    expect(parsed.flags).toMatchObject({
      app: "app_1",
      env: "prod",
      org: "org_1",
      endpoint: "https://cp.example",
      name: "Checkout",
      key: "checkout",
      targetingKey: "u1",
      contextJson: "{}",
      bodyJson: "{}",
      variants: "on,off",
      fromEnvironmentId: "env_1",
      enabled: true,
      rollout: 10,
      idempotencyKey: "idem-1",
      when: ["plan=enterprise"],
      serve: "on",
      json: true,
      confirm: true,
    });
  });
});
