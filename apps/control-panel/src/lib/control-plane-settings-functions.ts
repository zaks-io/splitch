import { env as workerEnv } from "cloudflare:workers";
import { EnvironmentPolicySchema } from "@splitch/contracts";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { controlPanelMutationBindings } from "./bindings";
import { createControlPanelSettingsClient } from "./control-plane-settings";
import { loadSessionFromRequest } from "./session";

const SettingsScopeSchema = z.object({
  appId: z.string().min(1),
  environmentId: z.string().min(1),
});

const LockClientKeySchema = SettingsScopeSchema.extend({
  originAllowlist: z.array(z.string().min(1)).min(1),
});

const UpdatePolicySchema = SettingsScopeSchema.extend({
  policy: EnvironmentPolicySchema,
});

const RevokeApiKeySchema = SettingsScopeSchema.extend({
  keyId: z.string().min(1),
});

export const loadControlPanelSettings = createServerFn({ method: "GET" })
  .validator((data: unknown) => SettingsScopeSchema.parse(data))
  .handler(async ({ data }) => {
    const authorized = await authorizedSettingsClient();
    if (!authorized.ok) return authorized.result;
    return authorized.client.read(data);
  });

export const lockControlPanelClientKey = createServerFn({ method: "POST" })
  .validator((data: unknown) => LockClientKeySchema.parse(data))
  .handler(async ({ data }) => {
    const authorized = await authorizedSettingsClient();
    if (!authorized.ok) return authorized.result;
    return authorized.client.lockClientKey(data);
  });

export const provisionControlPanelApiKey = createServerFn({ method: "POST" })
  .validator((data: unknown) => SettingsScopeSchema.parse(data))
  .handler(async ({ data }) => {
    const authorized = await authorizedSettingsClient();
    if (!authorized.ok) return authorized.result;
    return authorized.client.provisionApiKey(data);
  });

export const revokeControlPanelApiKey = createServerFn({ method: "POST" })
  .validator((data: unknown) => RevokeApiKeySchema.parse(data))
  .handler(async ({ data }) => {
    const authorized = await authorizedSettingsClient();
    if (!authorized.ok) return authorized.result;
    const revoked = await authorized.client.revokeApiKey(data);
    if (!revoked.ok) return revoked;
    return authorized.client.read(data);
  });

export const updateControlPanelEnvironmentPolicy = createServerFn({ method: "POST" })
  .validator((data: unknown) => UpdatePolicySchema.parse(data))
  .handler(async ({ data }) => {
    const authorized = await authorizedSettingsClient();
    if (!authorized.ok) return authorized.result;
    return authorized.client.updatePolicy(data);
  });

async function authorizedSettingsClient(): Promise<
  | {
      ok: true;
      client: ReturnType<typeof createControlPanelSettingsClient>;
    }
  | {
      ok: false;
      result: {
        ok: false;
        status: 401;
        error: { code: "UNAUTHORIZED"; message: string; details: Record<string, never> };
      };
    }
> {
  const bindings = controlPanelMutationBindings(workerEnv);
  const loaded = await loadSessionFromRequest(bindings.SESSION_STORE, getRequest());
  if (!loaded.ok) {
    return {
      ok: false,
      result: {
        ok: false,
        status: 401,
        error: { code: "UNAUTHORIZED", message: "authentication required", details: {} },
      },
    };
  }
  return {
    ok: true,
    client: createControlPanelSettingsClient(
      bindings.CONTROL_PLANE_API,
      { actorId: loaded.session.userId, sessionExpiresAt: loaded.session.expiresAt },
      bindings.CONTROL_PANEL_DELEGATION_SECRET,
    ),
  };
}
