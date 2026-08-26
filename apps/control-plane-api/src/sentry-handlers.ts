import type { Repository } from "@splitch/db";
import type { HandlerArgs, RouteHandler } from "@splitch/worker-runtime";
import { renderError } from "@splitch/worker-runtime";
import { ORG_ADMIN_ROLES, requireOrgRole } from "./org-authz";
import { pathParam } from "./handler-input";
import { installationStatusResponse } from "./sentry-installation-response";
import { sealSentrySecret } from "./sentry-installation-secret";
import { sentryWebhookUrlError } from "./sentry-webhook-url";

/**
 * Sentry change-tracking installation routes.
 *
 * The Organization comes from the path and the caller's live Org role. Wiring a
 * Sentry organization decides where every App and Environment under this
 * Organization publishes its Flag changes, and Sentry holds a single signing
 * secret per provider for the whole org, so it is an Org-admin act rather than
 * an App-level or data-plane one.
 */

export interface SentryHandlerDeps {
  repo: Repository;
  secretKek?: string;
  secretKeyVersion?: string;
  allowedHosts?: string;
  now?: () => Date;
}

interface OrgInput {
  params: { orgId: string };
}
interface CreateInput {
  params: { orgId: string };
  body: { installationId: string; webhookUrl: string; webhookSecret?: string };
}
interface InstallationInput {
  params: { orgId: string; installationId: string };
}
interface RotationInput extends InstallationInput {
  body: { rotationId: string; webhookSecret?: string };
}

export function makeSentryHandlers(deps: SentryHandlerDeps) {
  const now = deps.now ?? (() => new Date());
  const admin = (args: HandlerArgs<unknown>) =>
    requireOrgRole(
      deps,
      pathParam(args.input, "orgId"),
      args.principal,
      ORG_ADMIN_ROLES,
      args.requestId,
    );

  return {
    list: (async (args: HandlerArgs<OrgInput>) => {
      const denied = await admin(args as HandlerArgs<unknown>);
      if (denied) return denied;
      const rows = await deps.repo.sentry.listInstallations(args.input.params.orgId);
      return Response.json({ installations: rows.map(installationStatusResponse) });
    }) satisfies RouteHandler<OrgInput>,

    create: (async (args: HandlerArgs<CreateInput>) => {
      const denied = await admin(args as HandlerArgs<unknown>);
      if (denied) return denied;
      return createInstallation(deps, now, args);
    }) satisfies RouteHandler<CreateInput>,

    get: (async (args: HandlerArgs<InstallationInput>) => {
      const denied = await admin(args as HandlerArgs<unknown>);
      if (denied) return denied;
      const row = await deps.repo.sentry.getInstallation(
        args.input.params.orgId,
        args.input.params.installationId,
      );
      if (!row) return notFound(args.requestId);
      return Response.json(installationStatusResponse(row));
    }) satisfies RouteHandler<InstallationInput>,

    remove: (async (args: HandlerArgs<InstallationInput>) => {
      const denied = await admin(args as HandlerArgs<unknown>);
      if (denied) return denied;
      await deps.repo.sentry.revokeInstallation(
        args.input.params.orgId,
        args.input.params.installationId,
        now().toISOString(),
      );
      return new Response(null, { status: 204 });
    }) satisfies RouteHandler<InstallationInput>,

    rotate: (async (args: HandlerArgs<RotationInput>) => {
      const denied = await admin(args as HandlerArgs<unknown>);
      if (denied) return denied;
      return rotateSecret(deps, now, args);
    }) satisfies RouteHandler<RotationInput>,
  };
}

async function createInstallation(
  deps: SentryHandlerDeps,
  now: () => Date,
  { input, requestId }: HandlerArgs<CreateInput>,
): Promise<Response> {
  const urlError = sentryWebhookUrlError(input.body.webhookUrl, {
    allowedHosts: deps.allowedHosts,
  });
  if (urlError) return invalidUrl(urlError, requestId);
  const orgId = input.params.orgId;
  const sealed = await sealSentrySecret(input.body.webhookSecret, deps);
  const existing = await deps.repo.sentry.getInstallation(orgId, input.body.installationId);
  if (existing) {
    // A minted secret is different on every call by construction, so a replay
    // can only be compared on the URL. A caller-supplied secret is compared
    // too: reusing an installationId with different content is the conflict
    // this check exists to catch.
    const changed =
      existing.webhookUrl !== input.body.webhookUrl ||
      (sealed.minted === null && existing.secretFingerprint !== sealed.fingerprint);
    if (changed) return reusedInstallationId(input.body.installationId, requestId);
    return Response.json(installationResponse(existing));
  }
  let row: Awaited<ReturnType<typeof deps.repo.sentry.createInstallation>>;
  try {
    row = await deps.repo.sentry.createInstallation(orgId, {
      installationId: input.body.installationId,
      webhookUrl: input.body.webhookUrl,
      secretCiphertext: sealed.ciphertext,
      secretKeyVersion: sealed.keyVersion,
      secretFingerprint: sealed.fingerprint,
      now: now().toISOString(),
    });
  } catch (cause) {
    // The unique index is the enforcement point, so it is also the detector:
    // reading first would leave a race that reports a 500 for the same
    // misconfiguration this branch explains.
    return await activeScopeConflict(deps, orgId, requestId, cause);
  }
  return Response.json({
    ...installationResponse(row),
    ...(sealed.minted === null ? {} : { webhookSecret: sealed.minted }),
  });
}

async function rotateSecret(
  deps: SentryHandlerDeps,
  now: () => Date,
  { input, requestId }: HandlerArgs<RotationInput>,
): Promise<Response> {
  const orgId = input.params.orgId;
  const existing = await deps.repo.sentry.getInstallation(orgId, input.params.installationId);
  if (existing?.status !== "active") return notFound(requestId);
  const sealed = await sealSentrySecret(input.body.webhookSecret, deps);
  if (existing.lastRotationId === input.body.rotationId) {
    // Same reasoning as create: a minted secret cannot be compared to a replay,
    // and the first call already surfaced the only copy of it.
    if (sealed.minted === null && existing.lastRotationFingerprint !== sealed.fingerprint) {
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
  const rotated = await deps.repo.sentry.rotateSecret(orgId, input.params.installationId, {
    rotationId: input.body.rotationId,
    secretCiphertext: sealed.ciphertext,
    secretKeyVersion: sealed.keyVersion,
    secretFingerprint: sealed.fingerprint,
    now: now().toISOString(),
  });
  if (!rotated) return notFound(requestId);
  return Response.json({
    installationId: rotated.installationId,
    rotationId: input.body.rotationId,
    status: "active",
    ...(sealed.minted === null ? {} : { webhookSecret: sealed.minted }),
  });
}

function installationResponse(row: {
  installationId: string;
  orgId: string;
  webhookUrl: string;
  status: "active" | "revoked";
}) {
  return {
    installationId: row.installationId,
    orgId: row.orgId,
    webhookUrl: row.webhookUrl,
    status: row.status,
  };
}

/**
 * An Organization publishes to one Sentry organization, enforced by
 * `sentry_installations_active_scope_unique`. D1 reports a unique violation by
 * column list, not by index name ("UNIQUE constraint failed:
 * sentry_installations.org_id"), so the index name is not matchable here;
 * pairing the generic violation with a live lookup of the row holding the
 * Organization identifies it without parsing that column list. Anything else
 * rethrows.
 */
async function activeScopeConflict(
  deps: SentryHandlerDeps,
  orgId: string,
  requestId: string,
  cause: unknown,
): Promise<Response> {
  const violated = cause instanceof Error && cause.message.includes("UNIQUE constraint failed");
  if (!violated) throw cause;
  const active = (await deps.repo.sentry.listInstallations(orgId)).find(
    (installation) => installation.status === "active",
  );
  if (!active) throw cause;
  return renderError(
    {
      code: "SENTRY_INSTALLATION_CONFLICT",
      message: "this Organization already publishes Flag changes to a Sentry organization",
      details: {
        activeInstallationId: active.installationId,
        recommendedAction: "REVOKE_ACTIVE_INSTALLATION",
      },
    },
    { requestId },
  );
}

function reusedInstallationId(installationId: string, requestId: string): Response {
  return renderError(
    {
      code: "IDEMPOTENCY_KEY_CONFLICT",
      message: "installationId was reused with different installation content",
      details: { scope: "sentry_installation", idempotencyKey: installationId },
    },
    { requestId },
  );
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
