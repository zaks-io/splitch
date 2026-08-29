import type { RouteContract } from "@splitch/contracts";
import { appScope, type Repository } from "@splitch/db";
import { type Registrar, type RouteHandler, renderError } from "@splitch/worker-runtime";
import { pathParam } from "./handler-input";

export function withLiveAppReadMembership(registrar: Registrar, repo: Repository): Registrar {
  return {
    mount(app, contract, handler) {
      registrar.mount(
        app,
        contract,
        requiresLiveAppMembership(contract) ? liveAppMembershipHandler(repo, handler) : handler,
      );
    },
  };
}

function requiresLiveAppMembership(contract: RouteContract): boolean {
  return (
    contract.method === "GET" &&
    contract.auth === "control-plane-token" &&
    contract.path.split("/").includes(":appId")
  );
}

function liveAppMembershipHandler<Input>(
  repo: Repository,
  handler: RouteHandler<Input>,
): RouteHandler<Input> {
  return async (args) => {
    const forbidden = await requireLiveAppReadMembership(
      repo,
      pathParam(args.input, "appId"),
      args.principal,
      args.requestId,
    );
    return forbidden ?? handler(args);
  };
}

export async function requireLiveAppReadMembership(
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
