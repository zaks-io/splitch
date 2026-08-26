import type {
  SentryInstallationCreateResponse,
  SentryInstallationStatus,
  SentrySecretRotationResponse,
} from "@splitch/contracts";
import {
  SentryInstallationCreateResponseSchema,
  SentryInstallationListResponseSchema,
  SentrySecretRotationResponseSchema,
} from "@splitch/contracts";
import type { ControlPlaneOperationResult } from "./operation-result";
import { parseControlPlaneResponse } from "./operation-result";

/**
 * Sentry change-tracking installations, as the Control Panel reaches them.
 *
 * splitch is the *provider* in Sentry's Generic feature-flag integration, and
 * Sentry's Add-Provider form only accepts a pasted signing secret. So the
 * operator's flow is two-way: paste Sentry's webhook URL in here, and paste the
 * secret this returns back into Sentry. `webhookSecret` is omitted on install
 * and rotate precisely so the server mints it, and the response carries it
 * ONCE — nothing can read it back afterwards.
 */

export interface PanelSentryScope {
  appId: string;
  environmentId: string;
}

export interface PanelSentryInstallInput extends PanelSentryScope {
  installationId: string;
  webhookUrl: string;
}

export interface PanelSentryInstallationInput extends PanelSentryScope {
  installationId: string;
}

export interface PanelSentryRotateInput extends PanelSentryInstallationInput {
  rotationId: string;
}

export interface PanelSentryRevokeOutput {
  revoked: true;
}

export interface PanelSentryClient {
  list(
    input: PanelSentryScope,
  ): Promise<ControlPlaneOperationResult<{ installations: SentryInstallationStatus[] }>>;
  install(
    input: PanelSentryInstallInput,
  ): Promise<ControlPlaneOperationResult<SentryInstallationCreateResponse>>;
  rotateSecret(
    input: PanelSentryRotateInput,
  ): Promise<ControlPlaneOperationResult<SentrySecretRotationResponse>>;
  revoke(
    input: PanelSentryInstallationInput,
  ): Promise<ControlPlaneOperationResult<PanelSentryRevokeOutput>>;
}

export function createPanelSentryClient(options: {
  fetch: typeof fetch;
  baseUrl?: string;
}): PanelSentryClient {
  const baseUrl = options.baseUrl ?? "https://control-plane.internal";
  const installationsUrl = ({ appId, environmentId }: PanelSentryScope, suffix = "") =>
    new URL(
      `/apps/${encodeURIComponent(appId)}/envs/${encodeURIComponent(environmentId)}` +
        `/integrations/sentry/installations${suffix}`,
      baseUrl,
    );

  return {
    async list(input) {
      const response = await options.fetch(installationsUrl(input));
      return parseControlPlaneResponse(response, "sentry_installations_list", {
        safeParse: (body) => SentryInstallationListResponseSchema.safeParse(body),
      });
    },
    async install({ appId, environmentId, ...body }) {
      const response = await options.fetch(
        installationsUrl({ appId, environmentId }),
        jsonRequest("POST", body),
      );
      return parseControlPlaneResponse(response, "sentry_installations_create", {
        safeParse: (input) => SentryInstallationCreateResponseSchema.safeParse(input),
      });
    },
    async rotateSecret({ appId, environmentId, installationId, rotationId }) {
      const response = await options.fetch(
        installationsUrl(
          { appId, environmentId },
          `/${encodeURIComponent(installationId)}/secret-rotations`,
        ),
        jsonRequest("POST", { rotationId }),
      );
      return parseControlPlaneResponse(response, "sentry_secret_rotations_create", {
        safeParse: (input) => SentrySecretRotationResponseSchema.safeParse(input),
      });
    },
    async revoke({ appId, environmentId, installationId }) {
      const response = await options.fetch(
        installationsUrl({ appId, environmentId }, `/${encodeURIComponent(installationId)}`),
        { method: "DELETE" },
      );
      return parseControlPlaneResponse(response, "sentry_installations_delete", {
        safeParse: parseRevoked,
      });
    },
  };
}

function jsonRequest(method: "POST", body: unknown): RequestInit {
  return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

/** The revoke route answers 204 with no body, so an empty body IS the success. */
function parseRevoked(
  input: unknown,
): { success: true; data: PanelSentryRevokeOutput } | { success: false } {
  return input === null ? { success: true, data: { revoked: true } } : { success: false };
}
