import type { CloudflareInstallationListResponse } from "@splitch/contracts";
import { CloudflareInstallationListResponseSchema } from "@splitch/contracts";
import type { ControlPlaneOperationResult } from "./operation-result";
import { parseControlPlaneResponse } from "./operation-result";

export interface PanelCloudflareScope {
  appId: string;
  environmentId: string;
}

export interface PanelCloudflareInstallationInput extends PanelCloudflareScope {
  installationId: string;
}

export interface PanelCloudflareRevokeOutput {
  revoked: true;
}

export interface PanelCloudflareClient {
  list(
    input: PanelCloudflareScope,
  ): Promise<ControlPlaneOperationResult<CloudflareInstallationListResponse>>;
  revoke(
    input: PanelCloudflareInstallationInput,
  ): Promise<ControlPlaneOperationResult<PanelCloudflareRevokeOutput>>;
}

export function createPanelCloudflareClient(options: {
  fetch: typeof fetch;
  baseUrl?: string;
}): PanelCloudflareClient {
  const baseUrl = options.baseUrl ?? "https://control-plane.internal";
  const installationsUrl = ({ appId, environmentId }: PanelCloudflareScope, suffix = "") =>
    new URL(
      `/apps/${encodeURIComponent(appId)}/envs/${encodeURIComponent(environmentId)}` +
        `/integrations/cloudflare/installations${suffix}`,
      baseUrl,
    );

  return {
    async list(input) {
      const response = await options.fetch(installationsUrl(input));
      return parseControlPlaneResponse(response, "cloudflare_installations_list", {
        safeParse: (body) => CloudflareInstallationListResponseSchema.safeParse(body),
      });
    },
    async revoke({ appId, environmentId, installationId }) {
      const response = await options.fetch(
        installationsUrl({ appId, environmentId }, `/${encodeURIComponent(installationId)}`),
        { method: "DELETE" },
      );
      return parseControlPlaneResponse(response, "cloudflare_installations_revoke", {
        safeParse: parseRevoked,
      });
    },
  };
}

/** The revoke route answers 204 with no body, so an empty body IS the success. */
function parseRevoked(
  input: unknown,
): { success: true; data: PanelCloudflareRevokeOutput } | { success: false } {
  return input === null ? { success: true, data: { revoked: true } } : { success: false };
}
