import type { PanelEnvironmentSettings } from "@splitch/control-plane-sdk/panel-settings";
import { appScope, envScope, type Repository } from "@splitch/db";
import { renderError, type Principal } from "@splitch/worker-runtime";
import { requireAppAdmin } from "./app-authz";
import { environmentResponse } from "./app-environment-model";
import { clientKeyResponse, provisionClientKey } from "./client-key-provisioning";
import type { CredentialCacheWriterAccess } from "./credential-cache";

interface PanelSettingsDeps {
  repo: Repository;
  credentialStore: KVNamespace;
  credentialCacheWriter: CredentialCacheWriterAccess;
}

interface PanelSettingsInput {
  appId: string;
  environmentId: string;
}

const HASH_PREFIX_LENGTH = 12;

export async function panelSettingsRead(
  deps: PanelSettingsDeps,
  input: PanelSettingsInput,
  principal: Principal,
): Promise<Response> {
  const requestId = crypto.randomUUID();
  const adminError = await requireAppAdmin(deps, input.appId, principal, requestId);
  if (adminError) return adminError;

  const app = await deps.repo.identity.getApp(input.appId);
  const environment = await deps.repo.identity.getEnvironment(
    appScope(input.appId),
    input.environmentId,
  );
  if (!app || !environment) {
    return renderError(
      { code: "APP_NOT_FOUND", message: "App environment not found", details: {} },
      { requestId },
    );
  }

  const scope = envScope(input.appId, input.environmentId);
  const [clientKey, apiKeys] = await Promise.all([
    provisionClientKey(deps, {
      appId: input.appId,
      environmentId: input.environmentId,
      organizationId: app.organizationId,
      scope,
    }),
    deps.repo.credentials.listApiKeys(scope),
  ]);
  const response: PanelEnvironmentSettings = {
    environment: environmentResponse(environment),
    clientKey: clientKeyResponse(clientKey),
    apiKeys: apiKeys.map((key) => ({
      keyId: key.keyId,
      // The panel needs a stable fingerprint for operators, never the stored
      // full hash and never the irrecoverable secret.
      keyHashPrefix: key.keyHash.slice(0, HASH_PREFIX_LENGTH),
      scopes: JSON.parse(key.scopes) as string[],
      createdAt: key.createdAt,
      revokedAt: key.revokedAt,
    })),
  };
  return Response.json(response);
}
