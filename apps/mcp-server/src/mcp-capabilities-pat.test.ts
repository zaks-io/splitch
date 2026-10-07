import { describe, expect, it } from "vitest";
import { buildCapabilitiesResource } from "./mcp-capabilities";

describe("splitch://capabilities for a Personal Access Token", () => {
  const scopes = ["app:app_one:admin"];
  const granted = (resource: ReturnType<typeof buildCapabilitiesResource>, name: string) =>
    resource.tools.find((tool) => tool.name === name)?.grantedBy ?? [];

  it("grants reads from read scopes but no mutation on a read-only token", () => {
    const resource = buildCapabilitiesResource({
      scopes,
      membershipWideRead: true,
      personalAccessToken: { id: "pat_x", writeScopes: [], writeAll: false },
    });
    expect(granted(resource, "apps_get")).toContain("app:app_one:admin");
    expect(granted(resource, "apps_update")).toEqual([]);
    expect(resource.personalAccessToken).toMatchObject({ id: "pat_x" });
  });

  it("grants mutations only through write scopes", () => {
    const resource = buildCapabilitiesResource({
      scopes,
      membershipWideRead: true,
      personalAccessToken: { id: "pat_x", writeScopes: ["app:app_one:admin"], writeAll: false },
    });
    expect(granted(resource, "apps_update")).toContain("app:app_one:admin");
  });

  it("leaves non-PAT authority unchanged", () => {
    const resource = buildCapabilitiesResource({ scopes, membershipWideRead: false });
    expect(granted(resource, "apps_update")).toContain("app:app_one:admin");
    expect(resource).not.toHaveProperty("personalAccessToken");
  });
});
