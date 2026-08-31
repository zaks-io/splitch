import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authorizedAppSettingsPageClients } from "#lib/auth/panel-authorized-clients";

const AppSettingsPageScopeSchema = z
  .object({
    appId: z.string().min(1),
    environmentId: z.string().min(1),
  })
  .strict();

export const loadAppSettingsPage = createServerFn({ method: "GET" })
  .validator((data: unknown) => AppSettingsPageScopeSchema.parse(data))
  .handler(async ({ data }) => {
    const authorized = await authorizedAppSettingsPageClients(data.environmentId);
    if (!authorized.ok) return authorized.result;
    const scope = { appId: data.appId, environmentId: data.environmentId };
    const [appSettings, environmentSettings, exposureStatus] = await Promise.all([
      authorized.client.appSettings.read({ appId: data.appId }),
      authorized.client.environmentSettings.read(scope),
      authorized.client.exposureStatus.get(scope),
    ]);
    return { ok: true as const, data: { appSettings, environmentSettings, exposureStatus } };
  });
