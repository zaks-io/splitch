import type { Repository } from "@splitch/db";
import { envScope } from "@splitch/db";
import type { HandlerArgs, RouteHandler } from "@splitch/worker-runtime";
import { renderError } from "@splitch/worker-runtime";
import { encryptIntegrationSecret } from "./integration-secret";

export interface CloudflareHandlerDeps {
  repo: Repository;
  secretKek?: string;
  secretKeyVersion?: string;
  now?: () => Date;
}

interface CreateInput {
  body: { installationId: string; endpoint: string; pushSecret: string };
}
interface InstallationInput {
  params: { installationId: string };
}

export function makeCloudflareHandlers(deps: CloudflareHandlerDeps) {
  const now = deps.now ?? (() => new Date());
  return {
    create: (async ({ input, principal, requestId }: HandlerArgs<CreateInput>) => {
      const scope = principalScope(principal, requestId);
      if (scope instanceof Response) return scope;
      const endpointError = validateEndpoint(input.body.endpoint, requestId);
      if (endpointError) return endpointError;
      const encrypted = await encryptIntegrationSecret(
        input.body.pushSecret,
        deps.secretKek,
        deps.secretKeyVersion,
        "INTEGRATION_SECRET_KEK",
      );
      const existing = await deps.repo.cloudflare.getInstallation(scope, input.body.installationId);
      if (
        existing &&
        (existing.endpoint !== input.body.endpoint ||
          existing.secretFingerprint !== encrypted.fingerprint)
      )
        return renderError(
          {
            code: "IDEMPOTENCY_KEY_CONFLICT",
            message: "installationId was reused with different installation content",
            details: {
              scope: "cloudflare_installation",
              idempotencyKey: input.body.installationId,
            },
          },
          { requestId },
        );
      const row =
        existing ??
        (await deps.repo.cloudflare.createInstallation(scope, {
          installationId: input.body.installationId,
          endpoint: input.body.endpoint,
          secretCiphertext: encrypted.ciphertext,
          secretKeyVersion: encrypted.keyVersion,
          secretFingerprint: encrypted.fingerprint,
          now: now().toISOString(),
        }));
      const environmentVersion = await deps.repo.cloudflare.environmentVersion(scope);
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
        deps.repo.cloudflare.getInstallation(scope, input.params.installationId),
        deps.repo.cloudflare.environmentVersion(scope),
        deps.repo.cloudflare.deliveryHealth(scope, input.params.installationId, now().getTime()),
      ]);
      if (!row) return notFound(requestId);
      return Response.json({
        installationId: row.installationId,
        appId: scope.appId,
        environmentId: scope.environmentId,
        environmentVersion,
        status: row.status,
        endpoint: row.endpoint,
        lastAppliedVersion: row.lastAppliedVersion,
        lastAppliedAt: row.lastAppliedAt,
        ...health,
        latestDeliveryError: row.latestDeliveryErrorJson
          ? JSON.parse(row.latestDeliveryErrorJson)
          : null,
      });
    }) satisfies RouteHandler<InstallationInput>,

    remove: (async ({ input, principal, requestId }: HandlerArgs<InstallationInput>) => {
      const scope = principalScope(principal, requestId);
      if (scope instanceof Response) return scope;
      await deps.repo.cloudflare.revokeInstallation(
        scope,
        input.params.installationId,
        now().toISOString(),
      );
      return new Response(null, { status: 204 });
    }) satisfies RouteHandler<InstallationInput>,
  };
}

function principalScope(principal: HandlerArgs<unknown>["principal"], requestId: string) {
  if (!principal.appId || !principal.environmentId)
    return renderError(
      { code: "FORBIDDEN", message: "API Key is not bound to an App and Environment", details: {} },
      { requestId },
    );
  return envScope(principal.appId, principal.environmentId);
}

function validateEndpoint(value: string, requestId: string): Response | null {
  const url = new URL(value);
  const valid =
    url.protocol === "https:" &&
    url.hostname.endsWith(".workers.dev") &&
    !url.username &&
    !url.password &&
    !url.port &&
    !url.search &&
    !url.hash &&
    url.pathname === "/integrations/splitch/configuration";
  return valid
    ? null
    : renderError(
        {
          code: "VALIDATION_ERROR",
          message: "endpoint must be an HTTPS workers.dev Splitch configuration endpoint",
          details: {
            issues: [{ path: ["body", "endpoint"], message: "invalid Cloudflare Worker endpoint" }],
          },
        },
        { requestId },
      );
}

function notFound(requestId: string): Response {
  return renderError(
    {
      code: "CLOUDFLARE_INSTALLATION_NOT_FOUND",
      message: "Cloudflare installation not found",
      details: {},
    },
    { requestId },
  );
}
