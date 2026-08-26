import type { Repository } from "@splitch/db";
import { envScope } from "@splitch/db";
import type { HandlerArgs, RouteHandler } from "@splitch/worker-runtime";
import { renderError } from "@splitch/worker-runtime";
import { encryptIntegrationSecret } from "./integration-secret";
import { sentryWebhookUrlError } from "./sentry-webhook-url";

/**
 * Sentry change-tracking installation routes.
 *
 * The Environment comes from the API Key's Principal, never the body, so a
 * credential for one Environment cannot wire another Environment's Flag changes
 * into a Sentry organization.
 */

export interface SentryHandlerDeps {
  repo: Repository;
  secretKek?: string;
  secretKeyVersion?: string;
  allowedHosts?: string;
  now?: () => Date;
}

interface CreateInput {
  body: { installationId: string; webhookUrl: string; webhookSecret: string };
}
interface InstallationInput {
  params: { installationId: string };
}
interface RotationInput extends InstallationInput {
  body: { rotationId: string; webhookSecret: string };
}

export function makeSentryHandlers(deps: SentryHandlerDeps) {
  const now = deps.now ?? (() => new Date());
  return {
    create: (async ({ input, principal, requestId }: HandlerArgs<CreateInput>) => {
      const scope = principalScope(principal, requestId);
      if (scope instanceof Response) return scope;
      const urlError = sentryWebhookUrlError(input.body.webhookUrl, {
        allowedHosts: deps.allowedHosts,
      });
      if (urlError) return invalidUrl(urlError, requestId);
      const encrypted = await encryptIntegrationSecret(
        input.body.webhookSecret,
        deps.secretKek,
        deps.secretKeyVersion,
        "INTEGRATION_SECRET_KEK",
      );
      const existing = await deps.repo.sentry.getInstallation(scope, input.body.installationId);
      if (
        existing &&
        (existing.webhookUrl !== input.body.webhookUrl ||
          existing.secretFingerprint !== encrypted.fingerprint)
      ) {
        return renderError(
          {
            code: "IDEMPOTENCY_KEY_CONFLICT",
            message: "installationId was reused with different installation content",
            details: { scope: "sentry_installation", idempotencyKey: input.body.installationId },
          },
          { requestId },
        );
      }
      const row =
        existing ??
        (await deps.repo.sentry.createInstallation(scope, {
          installationId: input.body.installationId,
          webhookUrl: input.body.webhookUrl,
          secretCiphertext: encrypted.ciphertext,
          secretKeyVersion: encrypted.keyVersion,
          secretFingerprint: encrypted.fingerprint,
          now: now().toISOString(),
        }));
      return Response.json({
        installationId: row.installationId,
        appId: scope.appId,
        environmentId: scope.environmentId,
        webhookUrl: row.webhookUrl,
        status: row.status,
      });
    }) satisfies RouteHandler<CreateInput>,

    get: (async ({ input, principal, requestId }: HandlerArgs<InstallationInput>) => {
      const scope = principalScope(principal, requestId);
      if (scope instanceof Response) return scope;
      const row = await deps.repo.sentry.getInstallation(scope, input.params.installationId);
      if (!row) return notFound(requestId);
      return Response.json({
        installationId: row.installationId,
        appId: scope.appId,
        environmentId: scope.environmentId,
        webhookUrl: row.webhookUrl,
        status: row.status,
        lastDeliveredSeq: row.lastDeliveredSeq,
        lastDeliveredAt: row.lastDeliveredAt,
        attemptCount: row.attemptCount,
        nextAttemptAt: row.nextAttemptAt,
        latestDeliveryError: row.latestDeliveryErrorJson
          ? JSON.parse(row.latestDeliveryErrorJson)
          : null,
      });
    }) satisfies RouteHandler<InstallationInput>,

    remove: (async ({ input, principal, requestId }: HandlerArgs<InstallationInput>) => {
      const scope = principalScope(principal, requestId);
      if (scope instanceof Response) return scope;
      await deps.repo.sentry.revokeInstallation(
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
      const existing = await deps.repo.sentry.getInstallation(scope, input.params.installationId);
      if (existing?.status !== "active") return notFound(requestId);
      const encrypted = await encryptIntegrationSecret(
        input.body.webhookSecret,
        deps.secretKek,
        deps.secretKeyVersion,
        "INTEGRATION_SECRET_KEK",
      );
      if (existing.lastRotationId === input.body.rotationId) {
        if (existing.lastRotationFingerprint !== encrypted.fingerprint) {
          return renderError(
            {
              code: "IDEMPOTENCY_KEY_CONFLICT",
              message: "rotationId was reused with a different secret",
              details: { scope: "sentry_secret_rotation", idempotencyKey: input.body.rotationId },
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
      const rotated = await deps.repo.sentry.rotateSecret(scope, input.params.installationId, {
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

function invalidUrl(reason: string, requestId: string): Response {
  return renderError(
    {
      code: "VALIDATION_ERROR",
      message: reason,
      details: { issues: [{ path: ["body", "webhookUrl"], message: reason }] },
    },
    { requestId },
  );
}

function notFound(requestId: string): Response {
  return renderError(
    {
      code: "SENTRY_INSTALLATION_NOT_FOUND",
      message: "Sentry installation not found",
      details: {},
    },
    { requestId },
  );
}
