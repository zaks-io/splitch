import type { ConvexInstallationRow } from "@splitch/db";
import type { HandlerArgs, RouteHandler } from "@splitch/worker-runtime";
import { renderError } from "@splitch/worker-runtime";
import { configurationCallbackDestinationError } from "./configuration-callback-transport";
import { verifyConfigurationCallback } from "./configuration-callback-verification";
import type { ConvexHandlerDeps } from "./convex-handlers";
import { convexPrincipalScope } from "./convex-installation-response";
import { encryptConvexSecret } from "./convex-secret";

export interface ConvexInstallationCreateInput {
  body: {
    installationId: string;
    callbackUrl: string;
    webhookSecret: string;
    callbackVerification?: "hmac-sha256";
  };
}
export function makeConvexInstallationCreateHandler(
  deps: ConvexHandlerDeps,
  now: () => Date,
): RouteHandler<ConvexInstallationCreateInput> {
  return (async ({ input, principal, requestId }: HandlerArgs<ConvexInstallationCreateInput>) => {
    const scope = convexPrincipalScope(principal, requestId);
    if (scope instanceof Response) return scope;
    const callbackError = validateCallbackUrl(input.body, requestId);
    if (callbackError) return callbackError;
    const encrypted = await encryptConvexSecret(
      input.body.webhookSecret,
      deps.webhookKek,
      deps.webhookKeyVersion,
    );
    const existing = await deps.repo.convex.getInstallation(scope, input.body.installationId);
    const conflict = installationConflict(existing, input.body, encrypted.fingerprint, requestId);
    if (conflict) return conflict;
    const verificationError = await validateReceiver(existing, input.body, deps, now(), requestId);
    if (verificationError) return verificationError;
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
    const racedConflict = installationConflict(row, input.body, encrypted.fingerprint, requestId);
    return (
      racedConflict ??
      Response.json({
        installationId: row.installationId,
        appId: scope.appId,
        environmentId: scope.environmentId,
        environmentVersion: await deps.repo.convex.environmentVersion(scope),
        status: row.status,
      })
    );
  }) satisfies RouteHandler<ConvexInstallationCreateInput>;
}

function validateCallbackUrl(
  input: ConvexInstallationCreateInput["body"],
  requestId: string,
): Response | null {
  const error = configurationCallbackDestinationError(input.callbackUrl);
  if (error) return callbackValidationError(error, requestId);
  if (!input.callbackVerification && !new URL(input.callbackUrl).hostname.endsWith(".convex.site"))
    return callbackValidationError(
      "Custom-domain callbacks require a component with receiver verification support. Upgrade @splitch/convex and rerun install.",
      requestId,
    );
  return null;
}

function callbackValidationError(message: string, requestId: string): Response {
  return renderError(
    {
      code: "VALIDATION_ERROR",
      message,
      details: { issues: [{ path: ["body", "callbackUrl"], message }] },
    },
    { requestId },
  );
}

function installationConflict(
  row: ConvexInstallationRow | null,
  input: ConvexInstallationCreateInput["body"],
  fingerprint: string,
  requestId: string,
): Response | null {
  if (!row || (row.callbackUrl === input.callbackUrl && row.secretFingerprint === fingerprint))
    return null;
  return renderError(
    {
      code: "IDEMPOTENCY_KEY_CONFLICT",
      message: "installationId was reused with different installation content",
      details: { scope: "convex_installation", idempotencyKey: input.installationId },
    },
    { requestId },
  );
}

async function validateReceiver(
  existing: ConvexInstallationRow | null,
  input: ConvexInstallationCreateInput["body"],
  deps: ConvexHandlerDeps,
  now: Date,
  requestId: string,
): Promise<Response | null> {
  if (existing || !input.callbackVerification) return null;
  const verified = await verifyConfigurationCallback(input, now, deps.fetcher);
  if (verified.ok) return null;
  if (!verified.retryable) return callbackValidationError(verified.message, requestId);
  return renderError(
    { code: "SERVICE_UNAVAILABLE", message: verified.message, details: { retryAfterMs: 1_000 } },
    { requestId },
  );
}
