import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Control Panel Control Plane service binding", () => {
  const config = JSON.parse(
    readFileSync(new URL("../../../wrangler.jsonc", import.meta.url), "utf8"),
  ) as {
    placement?: { mode?: string };
    services?: Array<{ binding: string; service: string; entrypoint: string }>;
    env?: Record<
      string,
      { services?: Array<{ binding: string; service: string; entrypoint: string }> }
    >;
  };

  it("uses Smart Placement for the server-rendering Worker", () => {
    expect(config.placement).toEqual({ mode: "smart" });
  });

  it.each([
    ["local", "splitch-control-plane-api"],
    ["shared-preview", "splitch-control-plane-api-shared-preview"],
    ["production", "splitch-control-plane-api"],
  ])("binds %s to its matching Control Plane Worker", (target, service) => {
    const services = target === "local" ? config.services : config.env?.[target]?.services;
    expect(services).toContainEqual({
      binding: "CONTROL_PLANE_API",
      service,
      entrypoint: "SignedControlPanelEntrypoint",
    });
  });

  it("caches fingerprinted assets immutably", () => {
    const headers = readFileSync(new URL("../../../public/_headers", import.meta.url), "utf8");
    expect(headers).toContain("/assets/*");
    expect(headers).toContain("Cache-Control: public, max-age=31556952, immutable");
  });
});
