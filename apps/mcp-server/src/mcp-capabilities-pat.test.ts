import { describe, expect, it } from "vitest";
import { buildCapabilitiesResource } from "./mcp-capabilities";

describe("splitch://capabilities for a Personal Access Token", () => {
  const scopes = ["app:app_one:admin"];
  const granted = (resource: ReturnType<typeof buildCapabilitiesResource>, name: string) =>
    resource.tools.find((tool) => tool.name === name)?.grantedBy ?? [];
  const token = (permissions: PersonalAccessTokenPermission[]) => ({
    id: "pat_x",
    permissions: personalAccessTokenAuthority(
      { organizations: [], apps: [{ id: "app_one", organizationId: "org_one", role: "owner" }] },
      [{ target: "app:app_one", role: "admin", permissions }],
    ).permissions,
  });

  it("grants reads from read scopes but no mutation on a read-only token", () => {
    const resource = buildCapabilitiesResource({
      scopes,
      membershipWideRead: true,
      personalAccessToken: token([]),
    });
    expect(granted(resource, "apps_get")).toContain("app:app_one:admin");
    expect(granted(resource, "apps_update")).toEqual([]);
    expect(resource.personalAccessToken).toMatchObject({ id: "pat_x" });
  });

  it("grants mutations only through write scopes", () => {
    const resource = buildCapabilitiesResource({
      scopes,
      membershipWideRead: true,
      personalAccessToken: token(["write"]),
    });
    expect(granted(resource, "apps_update")).toContain("app:app_one:admin");
    for (const name of [
      "api_keys_create",
      "client_key_rotate",
      "flags_delete",
      "app_members_add",
      "app_privacy_export",
    ]) {
      expect(granted(resource, name)).toEqual([]);
    }
  });

  it("leaves non-PAT authority unchanged", () => {
    const resource = buildCapabilitiesResource({ scopes, membershipWideRead: false });
    expect(granted(resource, "apps_update")).toContain("app:app_one:admin");
    expect(resource).not.toHaveProperty("personalAccessToken");
  });
});

import {
  type PersonalAccessTokenPermission,
  personalAccessTokenAuthority,
} from "@splitch/contracts";
