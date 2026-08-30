import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authorizedConvexClient } from "#lib/auth/panel-authorized-clients";

const ConvexScopeSchema = z.object({
  appId: z.string().min(1),
  environmentId: z.string().min(1),
});

const ConvexInstallationSchema = ConvexScopeSchema.extend({ installationId: z.uuid() });

export const loadControlPanelConvexInstallations = createServerFn({ method: "GET" })
  .validator((data: unknown) => ConvexScopeSchema.parse(data))
  .handler(async ({ data }) => {
    const authorized = await authorizedConvexClient();
    if (!authorized.ok) return authorized.result;
    return authorized.client.list(data);
  });

export const revokeControlPanelConvexInstallation = createServerFn({ method: "POST" })
  .validator((data: unknown) => ConvexInstallationSchema.parse(data))
  .handler(async ({ data }) => {
    const authorized = await authorizedConvexClient();
    if (!authorized.ok) return authorized.result;
    return authorized.client.revoke(data);
  });
