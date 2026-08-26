import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authorizedSentryClient } from "./panel-authorized-clients";

/**
 * Sentry change-tracking installations, as the Environment settings screen
 * drives them.
 *
 * The signing secret never travels in a request from the browser: splitch mints
 * it server-side and returns it once, because Sentry's Add-Provider form only
 * accepts a pasted secret from its provider.
 */

const SentryScopeSchema = z.object({
  appId: z.string().min(1),
  environmentId: z.string().min(1),
});

const InstallSchema = SentryScopeSchema.extend({
  installationId: z.uuid(),
  webhookUrl: z.url(),
});

const InstallationSchema = SentryScopeSchema.extend({
  installationId: z.uuid(),
});

const RotateSchema = InstallationSchema.extend({
  rotationId: z.uuid(),
});

export const loadControlPanelSentryInstallations = createServerFn({ method: "GET" })
  .validator((data: unknown) => SentryScopeSchema.parse(data))
  .handler(async ({ data }) => {
    const authorized = await authorizedSentryClient();
    if (!authorized.ok) return authorized.result;
    return authorized.client.list(data);
  });

export const installControlPanelSentry = createServerFn({ method: "POST" })
  .validator((data: unknown) => InstallSchema.parse(data))
  .handler(async ({ data }) => {
    const authorized = await authorizedSentryClient();
    if (!authorized.ok) return authorized.result;
    return authorized.client.install(data);
  });

export const rotateControlPanelSentrySecret = createServerFn({ method: "POST" })
  .validator((data: unknown) => RotateSchema.parse(data))
  .handler(async ({ data }) => {
    const authorized = await authorizedSentryClient();
    if (!authorized.ok) return authorized.result;
    return authorized.client.rotateSecret(data);
  });

export const revokeControlPanelSentryInstallation = createServerFn({ method: "POST" })
  .validator((data: unknown) => InstallationSchema.parse(data))
  .handler(async ({ data }) => {
    const authorized = await authorizedSentryClient();
    if (!authorized.ok) return authorized.result;
    return authorized.client.revoke(data);
  });
