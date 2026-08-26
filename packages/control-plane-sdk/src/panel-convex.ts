import type { ConvexInstallationStatus } from "@splitch/contracts";
import { ConvexInstallationListResponseSchema } from "@splitch/contracts";
import type { ControlPlaneOperationResult } from "./operation-result";
import { parseControlPlaneResponse } from "./operation-result";

export interface PanelConvexScope {
  appId: string;
  environmentId: string;
}

export interface PanelConvexInstallationInput extends PanelConvexScope {
  installationId: string;
}

export interface PanelConvexRevokeOutput {
  revoked: true;
}

export interface PanelConvexClient {
  list(
    input: PanelConvexScope,
  ): Promise<ControlPlaneOperationResult<{ installations: ConvexInstallationStatus[] }>>;
  revoke(
    input: PanelConvexInstallationInput,
  ): Promise<ControlPlaneOperationResult<PanelConvexRevokeOutput>>;
}

export function createPanelConvexClient(options: {
  fetch: typeof fetch;
  baseUrl?: string;
}): PanelConvexClient {
  const baseUrl = options.baseUrl ?? "https://control-plane.internal";
  const installationsUrl = ({ appId, environmentId }: PanelConvexScope, suffix = "") =>
    new URL(
      `/apps/${encodeURIComponent(appId)}/envs/${encodeURIComponent(environmentId)}` +
        `/integrations/convex/installations${suffix}`,
      baseUrl,
    );

  return {
    async list(input) {
      const response = await options.fetch(installationsUrl(input));
      return parseControlPlaneResponse(response, "convex_panel_installations_list", {
        safeParse: (body) => ConvexInstallationListResponseSchema.safeParse(body),
      });
    },
    async revoke({ appId, environmentId, installationId }) {
      const response = await options.fetch(
        installationsUrl({ appId, environmentId }, `/${encodeURIComponent(installationId)}`),
        { method: "DELETE" },
      );
      return parseControlPlaneResponse(response, "convex_panel_installations_delete", {
        safeParse: parseRevoked,
      });
    },
  };
}

/** The revoke route answers 204 with no body, so an empty body IS the success. */
function parseRevoked(
  input: unknown,
): { success: true; data: PanelConvexRevokeOutput } | { success: false } {
  return input === null ? { success: true, data: { revoked: true } } : { success: false };
}
