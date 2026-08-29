import type { RouteContract } from "@splitch/contracts";
import { appScope, type Repository } from "@splitch/db";
import { type Registrar, type RouteHandler, renderError } from "@splitch/worker-runtime";
import { pathParam } from "./handler-input";

export function withLiveTenantMembership(registrar: Registrar, repo: Repository): Registrar {
  return {
    mount(app, contract, handler) {
      const requirements = liveMembershipRequirements(contract);
      registrar.mount(
        app,
        contract,
        requirements.app || requirements.organization
          ? liveTenantMembershipHandler(repo, handler, requirements)
          : handler,
      );
    },
  };
}

interface LiveMembershipRequirements {
  app: boolean;
  organization: boolean;
}

function liveMembershipRequirements(contract: RouteContract): LiveMembershipRequirements {
  const parameters = contract.path.split("/");
  const usesControlPlaneToken = contract.auth === "control-plane-token";
  return {
    app: usesControlPlaneToken && parameters.includes(":appId"),
    organization: usesControlPlaneToken && parameters.includes(":orgId"),
  };
}

function liveTenantMembershipHandler<Input>(
  repo: Repository,
  handler: RouteHandler<Input>,
  requirements: LiveMembershipRequirements,
): RouteHandler<Input> {
  return async (args) => {
    if (requirements.app) {
      const forbidden = await requireLiveAppMembership(
        repo,
        pathParam(args.input, "appId"),
        args.principal,
        args.requestId,
      );
      if (forbidden) return forbidden;
    }
    if (requirements.organization) {
      const forbidden = await requireLiveOrgMembership(
        repo,
        pathParam(args.input, "orgId"),
        args.principal,
        args.requestId,
      );
      if (forbidden) return forbidden;
    }
    return handler(args);
  };
}

export async function requireLiveAppMembership(
  repo: Repository,
  appId: string,
  principal: { id: string },
  requestId: string,
): Promise<Response | null> {
  if (await repo.identity.getAppMembership(appScope(appId), principal.id)) return null;

  // Preserve the existing not-found contract when the App itself is gone. A
  // live App with no membership must still fail before its handler can read data.
  if (!(await repo.identity.getApp(appId))) return null;
  return renderError(
    { code: "FORBIDDEN", message: "credential is not allowed for this App", details: {} },
    { requestId },
  );
}

async function requireLiveOrgMembership(
  repo: Repository,
  orgId: string,
  principal: { id: string },
  requestId: string,
): Promise<Response | null> {
  if (await repo.identity.getOrgMembership(orgId, principal.id)) return null;

  // Preserve the existing not-found contract when the Organization itself is
  // gone. A live Organization with no membership must fail before its handler.
  if (!(await repo.identity.getOrg(orgId))) return null;
  return renderError(
    {
      code: "FORBIDDEN",
      message: "credential is not allowed for this Organization",
      details: {},
    },
    { requestId },
  );
}
