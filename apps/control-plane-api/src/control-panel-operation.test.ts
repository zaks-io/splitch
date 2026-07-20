import { describe, expect, it } from "vitest";
import {
  parseControlPanelBindingOperation,
  parseControlPanelOperation,
} from "./control-panel-operation";

describe("Control Panel binding operation allowlist", () => {
  it.each([
    ["POST", "/orgs/org_1/apps", { id: "apps_create", orgId: "org_1" }],
    ["GET", "/apps/app_1/flags", { id: "flags_list", appId: "app_1", environmentId: "env_1" }],
    ["POST", "/apps/app_1/flags", { id: "flags_create", appId: "app_1", environmentId: "env_1" }],
    [
      "GET",
      "/apps/app_1/envs/env_1/flags/flag_1/config",
      { id: "flag_config_get", appId: "app_1", environmentId: "env_1", flagId: "flag_1" },
    ],
  ])("allows %s %s", (method, pathname, expected) => {
    expect(parseControlPanelOperation(method, pathname, "env_1")).toEqual(expected);
  });

  it.each([
    ["GET", "/orgs/org_1/apps"],
    ["PATCH", "/apps/app_1/flags/flag_1"],
    ["PATCH", "/apps/app_1/envs/env_1/flags/flag_1/config"],
    ["GET", "/apps/app_1/environments"],
    ["GET", "/health"],
  ])("rejects unsupported %s %s", (method, pathname) => {
    expect(parseControlPanelOperation(method, pathname)).toBeNull();
  });

  it("rejects forwarded bearer material before dispatch", () => {
    const request = new Request("https://control-plane.internal/apps/app_1/flags", {
      headers: { authorization: "Bearer must-not-cross" },
    });

    expect(parseControlPanelBindingOperation(request)).toBeNull();
  });

  it("rejects an App-level Flag operation without an Environment binding", () => {
    const request = new Request("https://control-plane.internal/apps/app_1/flags");

    expect(parseControlPanelBindingOperation(request)).toBeNull();
  });
});
