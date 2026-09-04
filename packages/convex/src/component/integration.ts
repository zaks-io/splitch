import {
  ConvexConfigSnapshotSchema,
  ConvexInstallationSchema,
} from "@splitch/sdk/local-evaluation";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { action, env, internalAction, internalMutation, internalQuery } from "./_generated/server";
import { canonicalCallbackUrl } from "./callback_url";
import { randomSecret } from "./crypto";
import { purgeBatchHandler, revokeLocalHandler, uninstallHandler } from "./integration_cleanup";
import { initializeHandler } from "./integration_initialize";
import {
  activateHandler,
  cancelPendingSyncRecovery,
  recoverSyncHandler,
  SYNC_RECOVERY_DELAY_MS,
  scheduleSyncRecovery,
} from "./integration_recovery";
import {
  installRejected,
  normalizedEndpoint,
  requestHeaders,
  responseJson,
  syncHandler,
} from "./integration_remote";
import { CURRENT_KEY, requiredIntegration } from "./integration_state";
import { ensureRetentionScheduled } from "./retention";
import schema from "./schema";
import { installationResultValidator } from "./validators";

const DEFAULT_ENDPOINT = "https://edge.splitch.dev";

export const get = internalQuery({
  args: {},
  returns: v.union(schema.doc("integrations"), v.null()),
  handler: async (ctx) =>
    ctx.db
      .query("integrations")
      .withIndex("by_key", (q) => q.eq("key", CURRENT_KEY))
      .unique(),
});

export const initialize = internalMutation({
  args: {
    installationId: v.string(),
    webhookSecret: v.string(),
    componentIdentityKey: v.string(),
    callbackUrl: v.string(),
    endpoint: v.string(),
  },
  returns: v.union(schema.doc("integrations"), v.null()),
  handler: (ctx, args) => initializeHandler(ctx, args),
});

export const activate = internalMutation({
  args: { appId: v.string(), environmentId: v.string(), environmentVersion: v.number() },
  returns: v.null(),
  handler: activateHandler,
});

export const install = action({
  args: {},
  returns: installationResultValidator,
  handler: async (
    ctx,
  ): Promise<{
    installationId: string;
    appId: string;
    environmentId: string;
    environmentVersion: number;
    status: "active" | "revoked";
  }> => {
    const cloudUrl = process.env.CONVEX_CLOUD_URL;
    if (!cloudUrl) throw new Error("CONVEX_CLOUD_URL is required to install @splitch/convex");
    const siteUrl = process.env.CONVEX_SITE_URL;
    if (!siteUrl) throw new Error("CONVEX_SITE_URL is required to install @splitch/convex");
    const endpoint = normalizedEndpoint(env.SPLITCH_ENDPOINT ?? DEFAULT_ENDPOINT);
    const headers = requestHeaders();
    const callbackUrl = canonicalCallbackUrl(cloudUrl, siteUrl);
    const initialized = await ctx.runMutation(internal.integration.initialize, {
      installationId: crypto.randomUUID(),
      webhookSecret: randomSecret(),
      componentIdentityKey: randomSecret(),
      callbackUrl,
      endpoint,
    });
    if (!initialized)
      throw new Error("@splitch/convex failed to initialize local installation state");
    const response = await fetch(`${endpoint}/api/integrations/convex/installations`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        installationId: initialized.installationId,
        callbackUrl: initialized.callbackUrl,
        webhookSecret: initialized.webhookSecret,
      }),
      redirect: "error",
    });
    if (!response.ok) throw installRejected(response.status, await response.text());
    const parsed = ConvexInstallationSchema.parse(await response.json());
    await ctx.runMutation(internal.integration.activate, {
      appId: parsed.appId,
      environmentId: parsed.environmentId,
      environmentVersion: parsed.environmentVersion,
    });
    await syncHandler(ctx);
    return parsed;
  },
});

export const sync = internalAction({
  args: {},
  returns: v.number(),
  handler: syncHandler,
});

export const syncNow = action({
  args: {},
  returns: v.number(),
  handler: syncHandler,
});

export const recoverSync = internalMutation({
  args: { environmentVersion: v.number() },
  returns: v.null(),
  handler: recoverSyncHandler,
});

export const commitSnapshot = internalMutation({
  args: { payload: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const snapshot = ConvexConfigSnapshotSchema.parse(JSON.parse(args.payload));
    const integration = await requiredIntegration(ctx);
    if (
      integration.appId !== snapshot.appId ||
      integration.environmentId !== snapshot.environmentId
    ) {
      throw new Error("Convex snapshot App or Environment does not match the installation");
    }
    if (snapshot.environmentVersion < integration.announcedVersion) {
      throw new Error(
        `Convex snapshot version ${snapshot.environmentVersion} is below announced version ${integration.announcedVersion}`,
      );
    }
    const existing = await ctx.db
      .query("snapshots")
      .withIndex("by_key", (q) => q.eq("key", CURRENT_KEY))
      .unique();
    if (existing && snapshot.environmentVersion < existing.environmentVersion) {
      throw new Error("Convex snapshot cannot move backwards");
    }
    if (existing)
      await ctx.db.replace(existing._id, {
        key: CURRENT_KEY,
        environmentVersion: snapshot.environmentVersion,
        payload: args.payload,
      });
    else
      await ctx.db.insert("snapshots", {
        key: CURRENT_KEY,
        environmentVersion: snapshot.environmentVersion,
        payload: args.payload,
      });
    await cancelPendingSyncRecovery(ctx, integration);
    await ctx.db.patch(integration._id, {
      snapshotVersion: snapshot.environmentVersion,
      syncRecoveryJobId: undefined,
      syncRecoveryVersion: undefined,
    });
  },
});

export const announce = internalMutation({
  args: {
    deliveryId: v.string(),
    appId: v.string(),
    environmentId: v.string(),
    environmentVersion: v.number(),
  },
  returns: v.union(v.literal("scheduled"), v.literal("duplicate")),
  handler: async (ctx, args): Promise<"scheduled" | "duplicate"> => {
    const integration = await requiredIntegration(ctx);
    if (
      integration.state !== "active" ||
      integration.appId !== args.appId ||
      integration.environmentId !== args.environmentId
    ) {
      throw new Error("Config nudge does not match the active Convex installation");
    }
    const prior = await ctx.db
      .query("webhookClaims")
      .withIndex("by_delivery", (q) => q.eq("deliveryId", args.deliveryId))
      .unique();
    if (prior || args.environmentVersion <= integration.announcedVersion) return "duplicate";
    await ctx.db.insert("webhookClaims", { deliveryId: args.deliveryId, claimedAt: Date.now() });
    await ensureRetentionScheduled(ctx);
    await ctx.db.patch(integration._id, { announcedVersion: args.environmentVersion });
    await ctx.scheduler.runAfter(0, internal.integration.sync, {});
    await scheduleSyncRecovery(
      ctx,
      { ...integration, announcedVersion: args.environmentVersion },
      SYNC_RECOVERY_DELAY_MS,
    );
    return "scheduled";
  },
});

export const stageRotation = internalMutation({
  args: { rotationId: v.string(), webhookSecret: v.string() },
  returns: v.object({
    installationId: v.string(),
    endpoint: v.string(),
    rotationId: v.string(),
    webhookSecret: v.string(),
  }),
  handler: async (ctx, args) => {
    const integration = await requiredIntegration(ctx);
    if (integration.previousWebhookSecret) {
      if (!integration.pendingRotationId)
        throw new Error("Convex webhook rotation state is missing its retry ID");
      return {
        installationId: integration.installationId,
        endpoint: integration.endpoint,
        rotationId: integration.pendingRotationId,
        webhookSecret: integration.webhookSecret,
      };
    }
    await ctx.db.patch(integration._id, {
      previousWebhookSecret: integration.webhookSecret,
      pendingRotationId: args.rotationId,
      webhookSecret: args.webhookSecret,
    });
    return {
      installationId: integration.installationId,
      endpoint: integration.endpoint,
      rotationId: args.rotationId,
      webhookSecret: args.webhookSecret,
    };
  },
});

export const finishRotation = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const integration = await requiredIntegration(ctx);
    await ctx.db.patch(integration._id, {
      previousWebhookSecret: undefined,
      pendingRotationId: undefined,
    });
  },
});

export const rotateSecret = action({
  args: {},
  returns: v.null(),
  handler: async (ctx): Promise<void> => {
    const webhookSecret = randomSecret();
    const rotationId = crypto.randomUUID();
    const rotation = await ctx.runMutation(internal.integration.stageRotation, {
      rotationId,
      webhookSecret,
    });
    if (!rotation.rotationId) throw new Error("Convex webhook rotation is missing its retry ID");
    const response = await fetch(
      `${rotation.endpoint}/api/integrations/convex/installations/${rotation.installationId}/secret-rotations`,
      {
        method: "POST",
        headers: requestHeaders(),
        body: JSON.stringify({
          rotationId: rotation.rotationId,
          webhookSecret: rotation.webhookSecret,
        }),
        redirect: "error",
      },
    );
    await responseJson(response, "rotate Convex webhook secret");
    await ctx.runMutation(internal.integration.finishRotation, {});
  },
});

export const revokeLocal = internalMutation({
  args: {},
  returns: v.null(),
  handler: revokeLocalHandler,
});

export const purgeBatch = internalMutation({
  args: {},
  returns: v.number(),
  handler: purgeBatchHandler,
});

export const uninstall = action({
  args: {},
  returns: v.null(),
  handler: uninstallHandler,
});
