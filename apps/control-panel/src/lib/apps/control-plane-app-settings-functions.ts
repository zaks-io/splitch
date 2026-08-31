import { SlugSchema, UserRoleSchema } from "@splitch/contracts";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { settleAppDelete, settleAppMutation } from "#lib/apps/app-settings-outcome";
import { authorizedAppSettingsClient } from "#lib/auth/panel-authorized-clients";

/**
 * Server functions for App Settings. Each one turns the browser session into a
 * least-privilege delegation over the Control Plane binding; no browser bearer
 * material is ever forwarded, and the Worker stays the authorization authority.
 */

const AppScopeSchema = z.object({ appId: z.string().min(1) });

const UpdateAppSchema = AppScopeSchema.extend({
  name: z.string().min(1).optional(),
  key: SlugSchema.optional(),
});

const AppMemberSchema = AppScopeSchema.extend({
  userId: z.string().min(1),
  role: UserRoleSchema,
});

const RemoveAppMemberSchema = AppScopeSchema.extend({ userId: z.string().min(1) });

const DeleteAppSchema = AppScopeSchema.extend({
  dryRun: z.boolean().optional(),
  force: z.boolean().optional(),
});

export const loadControlPanelAppSettings = createServerFn({ method: "GET" })
  .validator((data: unknown) => AppScopeSchema.parse(data))
  .handler(async ({ data }) => {
    const authorized = await authorizedAppSettingsClient();
    if (!authorized.ok) return authorized.result;
    return authorized.client.read(data);
  });

export const updateControlPanelApp = createServerFn({ method: "POST" })
  .validator((data: unknown) => UpdateAppSchema.parse(data))
  .handler(async ({ data }) => {
    const authorized = await authorizedAppSettingsClient();
    if (!authorized.ok) return authorized.result;
    return settleAppMutation(await authorized.client.updateApp(data), authorized.resyncSession);
  });

export const deleteControlPanelApp = createServerFn({ method: "POST" })
  .validator((data: unknown) => DeleteAppSchema.parse(data))
  .handler(async ({ data }) => {
    const authorized = await authorizedAppSettingsClient();
    if (!authorized.ok) return authorized.result;
    const result = await authorized.client.deleteApp(data);
    return settleAppDelete(
      result,
      () => authorized.client.deleteApp({ appId: data.appId, force: true }),
      authorized.resyncSession,
    );
  });

export const addControlPanelAppMember = createServerFn({ method: "POST" })
  .validator((data: unknown) => AppMemberSchema.parse(data))
  .handler(async ({ data }) => {
    const authorized = await authorizedAppSettingsClient();
    if (!authorized.ok) return authorized.result;
    return authorized.client.addMember(data);
  });

export const updateControlPanelAppMember = createServerFn({ method: "POST" })
  .validator((data: unknown) => AppMemberSchema.parse(data))
  .handler(async ({ data }) => {
    const authorized = await authorizedAppSettingsClient();
    if (!authorized.ok) return authorized.result;
    return authorized.client.updateMember(data);
  });

export const removeControlPanelAppMember = createServerFn({ method: "POST" })
  .validator((data: unknown) => RemoveAppMemberSchema.parse(data))
  .handler(async ({ data }) => {
    const authorized = await authorizedAppSettingsClient();
    if (!authorized.ok) return authorized.result;
    return authorized.client.removeMember(data);
  });
