import { describe, expect, it } from "vitest";
import {
  parseControlPanelBindingOperation,
  parseControlPanelOperation,
} from "./control-panel-operation";

/** Every path the Panel may claim, with the operation each one parses to. */
const CLAIMABLE: ReadonlyArray<[string, string, Record<string, string>]> = [
  ["POST", "/orgs/org_1/apps", { id: "apps_create", orgId: "org_1" }],
  ["GET", "/apps/app_1/attention-rollup", { id: "app_attention_rollup_get", appId: "app_1" }],
  ["GET", "/apps/app_1/flags", { id: "flags_list", appId: "app_1", environmentId: "env_1" }],
  ["POST", "/apps/app_1/flags", { id: "flags_create", appId: "app_1", environmentId: "env_1" }],
  ["GET", "/apps/app_1/segments", { id: "segments_list", appId: "app_1", environmentId: "env_1" }],
  [
    "GET",
    "/apps/app_1/flags/checkout?by=key",
    {
      id: "flag_get",
      appId: "app_1",
      environmentId: "env_1",
      flagId: "checkout",
      by: "key",
    },
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
  [
    "GET",
    "/orgs/org_1/integrations/sentry/installations",
    { id: "sentry_installations_list", orgId: "org_1" },
  ],
  [
    "POST",
    "/orgs/org_1/integrations/sentry/installations",
    { id: "sentry_installations_create", orgId: "org_1" },
  ],
  [
    "DELETE",
    "/orgs/org_1/integrations/sentry/installations/inst_1",
    { id: "sentry_installations_delete", orgId: "org_1", installationId: "inst_1" },
  ],
  [
    "POST",
    "/orgs/org_1/integrations/sentry/installations/inst_1/secret-rotations",
    { id: "sentry_secret_rotations_create", orgId: "org_1", installationId: "inst_1" },
  ],
];

/** Paths outside the allowlist: an unclaimable verb, selector, or read route. */
const UNCLAIMABLE: ReadonlyArray<[string, string]> = [
  ["GET", "/orgs/org_1/apps"],
  ["PATCH", "/apps/app_1/flags/flag_1"],
  // Dual-selector mode is required on the Flag resource read: missing or
  // unknown `by` is not claimable (never defaulted to id).
  ["GET", "/apps/app_1/flags/checkout"],
  ["GET", "/apps/app_1/flags/checkout?by=name"],
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
  // Reading one installation is an agent-only route: the Panel lists, so no
  // claim names a single installation for a read.
  ["GET", "/orgs/org_1/integrations/sentry/installations/inst_1"],
  ["PATCH", "/orgs/org_1/integrations/sentry/installations/inst_1"],
  ["GET", "/orgs/org_1/integrations/sentry/installations/inst_1/secret-rotations"],
  // The Environment-scoped path the installation used to live on is not a
  // second address for it.
  ["GET", "/apps/app_1/envs/env_1/integrations/sentry/installations"],
  ["GET", "/health"],
];

describe("Control Panel binding operation allowlist", () => {
  it.each(CLAIMABLE)("allows %s %s", (method, path, expected) => {
    const url = new URL(`https://control-plane.internal${path}`);
    expect(parseControlPanelOperation(method, url.pathname, "env_1", url.searchParams)).toEqual(
      expected,
    );
  });

  it.each(UNCLAIMABLE)("rejects unsupported %s %s", (method, path) => {
    const url = new URL(`https://control-plane.internal${path}`);
    expect(
      parseControlPanelOperation(method, url.pathname, undefined, url.searchParams),
    ).toBeNull();
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
