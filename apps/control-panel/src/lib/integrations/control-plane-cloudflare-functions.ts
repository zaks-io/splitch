import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authorizedCloudflareClient } from "#lib/auth/panel-authorized-clients";

const CloudflareScopeSchema = z.object({
  appId: z.string().min(1),
  environmentId: z.string().min(1),
});

const CloudflareInstallationSchema = CloudflareScopeSchema.extend({ installationId: z.uuid() });

export const loadControlPanelCloudflareInstallations = createServerFn({ method: "GET" })
  .validator((data: unknown) => CloudflareScopeSchema.parse(data))
  .handler(async ({ data }) => {
    const authorized = await authorizedCloudflareClient();
    if (!authorized.ok) return authorized.result;
    return authorized.client.list(data);
  });

export const revokeControlPanelCloudflareInstallation = createServerFn({ method: "POST" })
  .validator((data: unknown) => CloudflareInstallationSchema.parse(data))
  .handler(async ({ data }) => {
    const authorized = await authorizedCloudflareClient();
    if (!authorized.ok) return authorized.result;
    return authorized.client.revoke(data);
  });
