import { appScope } from "@splitch/db";
import { describe, expect, it, vi } from "vitest";
import { makePanelSessionAccess } from "./panel-session-access";
import { memoizePanelIdentityReads, repositoryForPanelRequest } from "./panel-request-repository";
import { panelScopeAccess } from "./panel-scope-access";

describe("memoizePanelIdentityReads", () => {
  it("shares the resolver's live identity reads with the handler recheck", async () => {
    const getApp = vi.fn(async () => ({ id: "app_1", organizationId: "org_1" }));
    const getAppMembership = vi.fn(async () => ({ role: "admin" }));
    const getEnvironment = vi.fn(async () => ({ id: "env_1", appId: "app_1" }));
    const getOrgMembershipForApp = vi.fn(async () => ({ role: "owner" }));
    const repo = memoizePanelIdentityReads({
      identity: {
        getApp,
        getAppMembership,
        getEnvironment,
        getOrgMembershipForApp,
      },
    } as never);

    const sessionAccess = makePanelSessionAccess(repo);
    await expect(sessionAccess.authorizeApp("user_1", "app_1", "env_1")).resolves.toMatchObject({
      appId: "app_1",
    });
    await expect(
      panelScopeAccess(
        repo,
        { actorId: "user_1", appId: "app_1", environmentId: "env_1" },
        "request_1",
      ),
    ).resolves.toMatchObject({ ok: true });

    expect(getApp).toHaveBeenCalledTimes(1);
    expect(getAppMembership).toHaveBeenCalledTimes(1);
    expect(getAppMembership).toHaveBeenCalledWith(appScope("app_1"), "user_1");
    expect(getEnvironment).toHaveBeenCalledTimes(1);
    expect(getOrgMembershipForApp).toHaveBeenCalledTimes(1);
  });

  it("does not share reads across different scopes", async () => {
    const getApp = vi.fn(async (appId: string) => ({ id: appId }));
    const repo = memoizePanelIdentityReads({ identity: { getApp } } as never);

    await repo.identity.getApp("app_1");
    await repo.identity.getApp("app_2");

    expect(getApp).toHaveBeenCalledTimes(2);
  });

  it("does not memoize mutation requests", () => {
    const repo = { identity: {} } as never;

    expect(repositoryForPanelRequest(repo, "signed", "POST")).toBe(repo);
    expect(repositoryForPanelRequest(repo, "bounded-session", "GET")).toBe(repo);
    expect(repositoryForPanelRequest(repo, "none", "GET")).toBe(repo);
    expect(repositoryForPanelRequest(repo, "signed", "GET")).not.toBe(repo);
  });
});
