import { describe, expect, it } from "vitest";
import { parseControlPanelOperation } from "./control-panel-operation";

const PROVIDERS = [
  {
    provider: "convex",
    listId: "convex_installations_list",
    deleteId: "convex_installations_revoke",
  },
  {
    provider: "cloudflare",
    listId: "cloudflare_installations_list",
    deleteId: "cloudflare_installations_revoke",
  },
] as const;

describe.each(PROVIDERS)("panel $provider operation parser", ({ provider, listId, deleteId }) => {
  const collection = `/apps/app%2Fone/envs/env%20prod/integrations/${provider}/installations`;

  it("decodes the collection scope", () => {
    expect(parseControlPanelOperation("GET", collection)).toEqual({
      id: listId,
      appId: "app/one",
      environmentId: "env prod",
    });
  });

  it("decodes the installation scope", () => {
    expect(parseControlPanelOperation("DELETE", `${collection}/inst%2Fone`)).toEqual({
      id: deleteId,
      appId: "app/one",
      environmentId: "env prod",
      installationId: "inst/one",
    });
  });

  it("rejects methods outside list and revoke", () => {
    expect(parseControlPanelOperation("POST", collection)).toBeNull();
    expect(parseControlPanelOperation("GET", `${collection}/inst_1`)).toBeNull();
  });

  it("rejects malformed encoded path segments", () => {
    expect(
      parseControlPanelOperation(
        "GET",
        `/apps/%E0%A4%A/envs/env_prod/integrations/${provider}/installations`,
      ),
    ).toBeNull();
    expect(parseControlPanelOperation("DELETE", `${collection}/%E0%A4%A`)).toBeNull();
  });
});
