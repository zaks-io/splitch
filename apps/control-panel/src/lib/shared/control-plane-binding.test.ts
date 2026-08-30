import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Control Panel Control Plane service binding", () => {
  it.each([
    ["local", "splitch-control-plane-api"],
    ["shared-preview", "splitch-control-plane-api-shared-preview"],
    ["production", "splitch-control-plane-api"],
  ])("binds %s to its matching Control Plane Worker", (target, service) => {
    const config = JSON.parse(
      readFileSync(new URL("../../../wrangler.jsonc", import.meta.url), "utf8"),
    ) as {
      services?: Array<{ binding: string; service: string; entrypoint: string }>;
      env?: Record<
        string,
        { services?: Array<{ binding: string; service: string; entrypoint: string }> }
      >;
    };
    const services = target === "local" ? config.services : config.env?.[target]?.services;
    expect(services).toContainEqual({
      binding: "CONTROL_PLANE_API",
      service,
      entrypoint: "SignedControlPanelEntrypoint",
    });
  });
});
