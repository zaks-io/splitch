import { boundListRead, LIST_READ_LIMIT } from "@splitch/contracts";
import type { Repository } from "@splitch/db";
import type { HandlerArgs, RouteHandler } from "@splitch/worker-runtime";
import { renderError } from "@splitch/worker-runtime";
import { requireAppAdmin } from "./app-authz";
import { makeConvexInstallationCreateHandler } from "./convex-installation-create";
import {
  convexInstallationStatusResponse,
  convexPrincipalScope,
  convexScope,
} from "./convex-installation-response";
import { encryptConvexSecret } from "./convex-secret";
import { buildConvexSnapshot } from "./convex-snapshot";
import { pathParam } from "./handler-input";

export interface ConvexHandlerDeps {
  repo: Repository;
  webhookKek?: string;
  webhookKeyVersion?: string;
  now?: () => Date;
  fetcher?: typeof fetch;
}

interface InstallationInput {
  params: { installationId: string };
}
interface PanelScopeInput {
  params: { appId: string; environmentId: string };
}
interface PanelInstallationInput extends PanelScopeInput {
  params: { appId: string; environmentId: string; installationId: string };
}
interface RotationInput extends InstallationInput {
  body: { rotationId: string; webhookSecret: string };
}

export function makeConvexHandlers(deps: ConvexHandlerDeps) {
  const now = deps.now ?? (() => new Date());
  return {
    panelList: makePanelListHandler(deps),
    panelRemove: makePanelRemoveHandler(deps, now),

    create: makeConvexInstallationCreateHandler(deps, now),

    get: (async ({ input, principal, requestId }: HandlerArgs<InstallationInput>) => {
      const scope = convexPrincipalScope(principal, requestId);
      if (scope instanceof Response) return scope;
      const [row, environmentVersion, health] = await Promise.all([
        deps.repo.convex.getInstallation(scope, input.params.installationId),
        deps.repo.convex.environmentVersion(scope),
        deps.repo.convex.deliveryHealth(scope, input.params.installationId, now().getTime()),
      ]);
      if (!row) return notFound(requestId);
      return Response.json(
        convexInstallationStatusResponse({ ...row, ...health }, environmentVersion),
      );
    }) satisfies RouteHandler<InstallationInput>,

    remove: (async ({ input, principal, requestId }: HandlerArgs<InstallationInput>) => {
      const scope = convexPrincipalScope(principal, requestId);
      if (scope instanceof Response) return scope;
      await deps.repo.convex.revokeInstallation(
        scope,
        input.params.installationId,
        now().toISOString(),
      );
      return new Response(null, { status: 204 });
    }) satisfies RouteHandler<InstallationInput>,

    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Rotation keeps its idempotency comparison and write in one auditable handler.
    rotate: (async ({ input, principal, requestId }: HandlerArgs<RotationInput>) => {
      const scope = convexPrincipalScope(principal, requestId);
      if (scope instanceof Response) return scope;
      const existing = await deps.repo.convex.getInstallation(scope, input.params.installationId);
      if (existing?.status !== "active") return notFound(requestId);
      const encrypted = await encryptConvexSecret(
        input.body.webhookSecret,
        deps.webhookKek,
        deps.webhookKeyVersion,
      );
      if (existing.lastRotationId === input.body.rotationId) {
        if (existing.lastRotationFingerprint !== encrypted.fingerprint) {
          return renderError(
            {
              code: "IDEMPOTENCY_KEY_CONFLICT",
              message: "rotationId was reused with a different secret",
              details: { scope: "convex_secret_rotation", idempotencyKey: input.body.rotationId },
            },
            { requestId },
          );
        }
        return Response.json({
          installationId: existing.installationId,
          rotationId: input.body.rotationId,
          status: "active",
        });
      }
      const rotated = await deps.repo.convex.rotateSecret(scope, input.params.installationId, {
        rotationId: input.body.rotationId,
        secretCiphertext: encrypted.ciphertext,
        secretKeyVersion: encrypted.keyVersion,
        secretFingerprint: encrypted.fingerprint,
        now: now().toISOString(),
      });
      if (!rotated) return notFound(requestId);
      return Response.json({
        installationId: rotated.installationId,
        rotationId: input.body.rotationId,
        status: "active",
      });
    }) satisfies RouteHandler<RotationInput>,

    snapshot: (async ({ principal, request, requestId }) => {
      const scope = convexPrincipalScope(principal, requestId);
      if (scope instanceof Response) return scope;
      const snapshot = await buildConvexSnapshot(deps.repo, scope);
      const etag = `"${snapshot.environmentVersion}"`;
      if (request.headers.get("if-none-match") === etag)
        return new Response(null, { status: 304, headers: { etag } });
      return Response.json(snapshot, { headers: { etag, "cache-control": "private, no-store" } });
    }) satisfies RouteHandler<Record<string, never>>,
  };
}

function makePanelListHandler(deps: ConvexHandlerDeps): RouteHandler<PanelScopeInput> {
  return async (args) => {
    const denied = await requireAppAdmin(
      deps,
      pathParam(args.input, "appId"),
      args.principal,
      args.requestId,
    );
    if (denied) return denied;
    const scope = convexScope(args.input.params);
    const scanned = await deps.repo.convex.listInstallations(scope, {
      limit: LIST_READ_LIMIT + 1,
    });
    // The Environment version only decorates rows, and `environmentVersion`
    // throws when the Environment is not in scope. Reading it up front turns a
    // mistyped environmentId (free input on the MCP tool and the CLI command)
    // into an undeclared 500 instead of the empty list the Sentry card returns
    // for the same case.
    if (scanned.length === 0) return Response.json(boundListRead([]));
    const environmentVersion = await deps.repo.convex.environmentVersion(scope);
    return Response.json(
      boundListRead(
        scanned.map((row) => convexInstallationStatusResponse(row, environmentVersion)),
      ),
    );
  };
}

function makePanelRemoveHandler(
  deps: ConvexHandlerDeps,
  now: () => Date,
): RouteHandler<PanelInstallationInput> {
  return async (args) => {
    const denied = await requireAppAdmin(
      deps,
      pathParam(args.input, "appId"),
      args.principal,
      args.requestId,
    );
    if (denied) return denied;
    const scope = convexScope(args.input.params);
    const existing = await deps.repo.convex.getInstallation(
      scope,
      args.input.params.installationId,
    );
    if (!existing) return notFound(args.requestId);
    await deps.repo.convex.revokeInstallation(
      scope,
      args.input.params.installationId,
      now().toISOString(),
    );
    return new Response(null, { status: 204 });
  };
}

function notFound(requestId: string): Response {
  return renderError(
    {
      code: "CONVEX_INSTALLATION_NOT_FOUND",
      message: "Convex installation not found",
      details: {},
    },
    { requestId },
  );
}
