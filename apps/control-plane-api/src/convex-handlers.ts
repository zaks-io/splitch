import type { Repository } from "@splitch/db";
import { envScope } from "@splitch/db";
import type { HandlerArgs, RouteHandler } from "@splitch/worker-runtime";
import { renderError } from "@splitch/worker-runtime";
import { encryptConvexSecret } from "./convex-secret";
import { buildConvexSnapshot } from "./convex-snapshot";

export interface ConvexHandlerDeps {
  repo: Repository;
  webhookKek?: string;
  webhookKeyVersion?: string;
  now?: () => Date;
}

interface CreateInput {
  body: { installationId: string; callbackUrl: string; webhookSecret: string };
}
interface InstallationInput {
  params: { installationId: string };
}
interface RotationInput extends InstallationInput {
  body: { rotationId: string; webhookSecret: string };
}

export function makeConvexHandlers(deps: ConvexHandlerDeps) {
  const now = deps.now ?? (() => new Date());
  return {
    create: (async ({ input, principal, requestId }: HandlerArgs<CreateInput>) => {
      const scope = principalScope(principal, requestId);
      if (scope instanceof Response) return scope;
      const callbackError = validateCallbackUrl(input.body.callbackUrl, requestId);
      if (callbackError) return callbackError;
      const encrypted = await encryptConvexSecret(
        input.body.webhookSecret,
        deps.webhookKek,
        deps.webhookKeyVersion,
      );
      const existing = await deps.repo.convex.getInstallation(scope, input.body.installationId);
      if (
        existing &&
        (existing.callbackUrl !== input.body.callbackUrl ||
          existing.secretFingerprint !== encrypted.fingerprint)
      ) {
        return renderError(
          {
            code: "IDEMPOTENCY_KEY_CONFLICT",
            message: "installationId was reused with different installation content",
            details: { scope: "convex_installation", idempotencyKey: input.body.installationId },
          },
          { requestId },
        );
      }
      const row =
        existing ??
        (await deps.repo.convex.createInstallation(scope, {
          installationId: input.body.installationId,
          callbackUrl: input.body.callbackUrl,
          secretCiphertext: encrypted.ciphertext,
          secretKeyVersion: encrypted.keyVersion,
          secretFingerprint: encrypted.fingerprint,
          now: now().toISOString(),
        }));
      const environmentVersion = await deps.repo.convex.environmentVersion(scope);
      return Response.json({
        installationId: row.installationId,
        appId: scope.appId,
        environmentId: scope.environmentId,
        environmentVersion,
        status: row.status,
      });
    }) satisfies RouteHandler<CreateInput>,

    get: (async ({ input, principal, requestId }: HandlerArgs<InstallationInput>) => {
      const scope = principalScope(principal, requestId);
      if (scope instanceof Response) return scope;
      const [row, environmentVersion, health] = await Promise.all([
        deps.repo.convex.getInstallation(scope, input.params.installationId),
        deps.repo.convex.environmentVersion(scope),
        deps.repo.convex.deliveryHealth(scope, input.params.installationId, now().getTime()),
      ]);
      if (!row) return notFound(requestId);
      return Response.json({
        installationId: row.installationId,
        appId: scope.appId,
        environmentId: scope.environmentId,
        environmentVersion,
        status: row.status,
        callbackUrl: row.callbackUrl,
        lastDeliveredVersion: row.lastDeliveredVersion,
        lastDeliveredAt: row.lastDeliveredAt,
        ...health,
        latestDeliveryError: row.latestDeliveryErrorJson
          ? JSON.parse(row.latestDeliveryErrorJson)
          : null,
      });
    }) satisfies RouteHandler<InstallationInput>,

    remove: (async ({ input, principal, requestId }: HandlerArgs<InstallationInput>) => {
      const scope = principalScope(principal, requestId);
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
      const scope = principalScope(principal, requestId);
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
      const scope = principalScope(principal, requestId);
      if (scope instanceof Response) return scope;
      const snapshot = await buildConvexSnapshot(deps.repo, scope);
      const etag = `"${snapshot.environmentVersion}"`;
      if (request.headers.get("if-none-match") === etag)
        return new Response(null, { status: 304, headers: { etag } });
      return Response.json(snapshot, { headers: { etag, "cache-control": "private, no-store" } });
    }) satisfies RouteHandler<Record<string, never>>,
  };
}

function principalScope(principal: HandlerArgs<unknown>["principal"], requestId: string) {
  if (!principal.appId || !principal.environmentId) {
    return renderError(
      { code: "FORBIDDEN", message: "API Key is not bound to an App and Environment", details: {} },
      { requestId },
    );
  }
  return envScope(principal.appId, principal.environmentId);
}

function validateCallbackUrl(value: string, requestId: string): Response | null {
  const url = new URL(value);
  const valid =
    url.protocol === "https:" &&
    url.hostname.endsWith(".convex.site") &&
    !url.username &&
    !url.password &&
    !url.port &&
    !url.search &&
    !url.hash &&
    url.pathname.endsWith("/configuration");
  return valid
    ? null
    : renderError(
        {
          code: "VALIDATION_ERROR",
          message: "callbackUrl must be an HTTPS *.convex.site configuration endpoint",
          details: {
            issues: [{ path: ["body", "callbackUrl"], message: "invalid Convex callback URL" }],
          },
        },
        { requestId },
      );
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
