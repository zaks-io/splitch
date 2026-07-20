import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ env: {} }));
import { controlPanelFlagConfigApi } from "./lib/control-plane-flag-functions";
import { getRouter } from "./router";

describe("production router context", () => {
  it("wires the server-side Flag Configuration API by default", () => {
    expect(getRouter().options.context.flagConfigApi).toBe(controlPanelFlagConfigApi);
  });
});
