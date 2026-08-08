import { describe, expect, it } from "vitest";
import {
  parseControlPanelBindingOperation,
  parseControlPanelOperation,
} from "./control-panel-operation";

describe("Control Panel binding operation allowlist", () => {
  it.each([
    ["POST", "/orgs/org_1/apps", { id: "apps_create", orgId: "org_1" }],
    ["GET", "/apps/app_1/attention-rollup", { id: "app_attention_rollup_get", appId: "app_1" }],
    ["GET", "/apps/app_1/flags", { id: "flags_list", appId: "app_1", environmentId: "env_1" }],
    ["POST", "/apps/app_1/flags", { id: "flags_create", appId: "app_1", environmentId: "env_1" }],
    [
      "GET",
      "/apps/app_1/segments",
      { id: "segments_list", appId: "app_1", environmentId: "env_1" },
    ],
    [
      "GET",
      "/apps/app_1/envs/env_1/flags/flag_1/config",
      { id: "flag_config_get", appId: "app_1", environmentId: "env_1", flagId: "flag_1" },
    ],
    [
      "PATCH",
      "/apps/app_1/envs/env_1/flags/flag_1/config",
      { id: "flag_config_update", appId: "app_1", environmentId: "env_1", flagId: "flag_1" },
    ],
    [
      "PUT",
      "/apps/app_1/envs/env_1/flags/flag_1/targeting-rules",
      {
        id: "flag_targeting_rules_replace",
        appId: "app_1",
        environmentId: "env_1",
        flagId: "flag_1",
      },
    ],
    [
      "POST",
      "/apps/app_1/envs/env_1/flags/flag_1/promote",
      {
        id: "flag_config_promote",
        appId: "app_1",
        environmentId: "env_1",
        flagId: "flag_1",
      },
    ],
    [
      "GET",
      "/apps/app_1/approval-requests/apr_1",
      { id: "approval_request_get", appId: "app_1", approvalRequestId: "apr_1" },
    ],
    [
      "POST",
      "/apps/app_1/approval-requests/apr_1/reviews",
      { id: "approval_request_review", appId: "app_1", approvalRequestId: "apr_1" },
    ],
    [
      "GET",
      "/control-panel/apps/app_1/envs/env_1/settings",
      { id: "settings_get", appId: "app_1", environmentId: "env_1" },
    ],
    [
      "PATCH",
      "/apps/app_1/envs/env_1",
      { id: "environment_update", appId: "app_1", environmentId: "env_1" },
    ],
    [
      "PATCH",
      "/apps/app_1/envs/env_1/client-key",
      { id: "client_key_update", appId: "app_1", environmentId: "env_1" },
    ],
    [
      "POST",
      "/apps/app_1/envs/env_1/api-keys",
      { id: "api_keys_create", appId: "app_1", environmentId: "env_1" },
    ],
    [
      "POST",
      "/apps/app_1/envs/env_1/api-keys/ak_1/revoke",
      { id: "api_key_revoke", appId: "app_1", environmentId: "env_1", keyId: "ak_1" },
    ],
  ])("allows %s %s", (method, pathname, expected) => {
    expect(parseControlPanelOperation(method, pathname, "env_1")).toEqual(expected);
  });

  it.each([
    ["GET", "/orgs/org_1/apps"],
    ["PATCH", "/apps/app_1/flags/flag_1"],
    // The panel writes Flag Configuration and reviews Approval Requests, but the
    // method is part of the operation: no other verb on those paths is claimable.
    ["DELETE", "/apps/app_1/envs/env_1/flags/flag_1/config"],
    ["POST", "/apps/app_1/envs/env_1/flags/flag_1/targeting-rules"],
    ["GET", "/apps/app_1/envs/env_1/flags/flag_1/promote"],
    ["DELETE", "/apps/app_1/approval-requests/apr_1"],
    ["GET", "/apps/app_1/approval-requests"],
    ["GET", "/apps/app_1/environments"],
    ["GET", "/apps/app_1/envs/env_1/api-keys"],
    ["POST", "/apps/app_1/envs/env_1/client-key/revoke"],
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
