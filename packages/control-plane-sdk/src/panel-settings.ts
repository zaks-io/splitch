import type { ClientKey, Environment, EnvironmentPolicy } from "@splitch/contracts";
import { ClientKeySchema, EnvironmentSchema } from "@splitch/contracts";
import type { ApiKeysCreateOutput, ApiKeysRevokeOutput } from "@splitch/contracts/route-types";
import { createControlPlaneSdk } from "./index";
import type { ControlPlaneOperationResult } from "./operation-result";
import { parseControlPlaneResponse } from "./operation-result";

const API_KEY_SCOPES = ["data-plane:evaluate", "data-plane:write"] as const;

export interface PanelSettingsScope {
  appId: string;
  environmentId: string;
}

export interface PanelApiKeyMetadata {
  keyId: string;
  keyHashPrefix: string;
  scopes: string[];
  createdAt: string;
  revokedAt?: string | null;
}

export interface PanelEnvironmentSettings {
  environment: Environment;
  clientKey: ClientKey;
  apiKeys: PanelApiKeyMetadata[];
}

export interface PanelSettingsClient {
  read(input: PanelSettingsScope): Promise<ControlPlaneOperationResult<PanelEnvironmentSettings>>;
  updatePolicy(
    input: PanelSettingsScope & { policy: EnvironmentPolicy },
  ): Promise<ControlPlaneOperationResult<Environment>>;
  lockClientKey(
    input: PanelSettingsScope & { originAllowlist: string[] },
  ): Promise<ControlPlaneOperationResult<ClientKey>>;
  provisionApiKey(
    input: PanelSettingsScope,
  ): Promise<ControlPlaneOperationResult<ApiKeysCreateOutput>>;
  revokeApiKey(
    input: PanelSettingsScope & { keyId: string },
  ): Promise<ControlPlaneOperationResult<ApiKeysRevokeOutput>>;
}

export function createPanelSettingsClient(options: {
  fetch: typeof fetch;
  baseUrl?: string;
}): PanelSettingsClient {
  const baseUrl = options.baseUrl ?? "https://control-plane.internal";
  const sdk = createControlPlaneSdk({ baseUrl, fetch: options.fetch });

  return {
    async read(input) {
      const path =
        `/control-panel/apps/${encodeURIComponent(input.appId)}` +
        `/envs/${encodeURIComponent(input.environmentId)}/settings`;
      const response = await options.fetch(new URL(path, baseUrl), { method: "GET" });
      return parseControlPlaneResponse<PanelEnvironmentSettings>(response, "panel_settings_get", {
        safeParse: parsePanelEnvironmentSettings,
      });
    },
    updatePolicy: ({ appId, environmentId, policy }) =>
      sdk.environments.update({ appId, environmentId, policy }),
    lockClientKey: ({ appId, environmentId, originAllowlist }) =>
      sdk.credentials.clientKey.update({ appId, environmentId, originAllowlist }),
    provisionApiKey: ({ appId, environmentId }) =>
      sdk.credentials.apiKeys.create({
        appId,
        environmentId,
        scopes: [...API_KEY_SCOPES],
      }),
    revokeApiKey: ({ appId, environmentId, keyId }) =>
      sdk.credentials.apiKeys.revoke({ appId, environmentId, keyId }),
  };
}

function parsePanelEnvironmentSettings(input: unknown) {
  if (!isRecord(input) || !hasOnlyKeys(input, ["environment", "clientKey", "apiKeys"])) {
    return { success: false as const };
  }
  const environment = EnvironmentSchema.safeParse(input.environment);
  const clientKey = ClientKeySchema.safeParse(input.clientKey);
  if (!environment.success || !clientKey.success || !Array.isArray(input.apiKeys)) {
    return { success: false as const };
  }
  const apiKeys = input.apiKeys.map(parseApiKeyMetadata);
  if (apiKeys.some((key) => key === null)) return { success: false as const };
  return {
    success: true as const,
    data: {
      environment: environment.data,
      clientKey: clientKey.data,
      apiKeys: apiKeys as PanelApiKeyMetadata[],
    },
  };
}

function parseApiKeyMetadata(input: unknown): PanelApiKeyMetadata | null {
  if (
    !isRecord(input) ||
    !hasOnlyKeys(input, ["keyId", "keyHashPrefix", "scopes", "createdAt", "revokedAt"], true) ||
    !isNonEmptyString(input.keyId) ||
    !/^[a-f0-9]{12}$/u.test(String(input.keyHashPrefix)) ||
    !Array.isArray(input.scopes) ||
    !input.scopes.every(isNonEmptyString) ||
    !isNonEmptyString(input.createdAt) ||
    !(
      input.revokedAt === undefined ||
      input.revokedAt === null ||
      isNonEmptyString(input.revokedAt)
    )
  ) {
    return null;
  }
  return {
    keyId: input.keyId,
    keyHashPrefix: String(input.keyHashPrefix),
    scopes: input.scopes,
    createdAt: input.createdAt,
    ...(input.revokedAt !== undefined ? { revokedAt: input.revokedAt as string | null } : {}),
  };
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: string[],
  optionalRevokedAt = false,
): boolean {
  const required = optionalRevokedAt ? allowed.filter((key) => key !== "revokedAt") : allowed;
  return (
    required.every((key) => key in value) &&
    Object.keys(value).every((key) => allowed.includes(key))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
