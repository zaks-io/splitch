import type { MutationCtx } from "./_generated/server";
import { isCanonicalCallbackUrl } from "./callback_url";
import { CURRENT_KEY } from "./integration_state";

interface InitializeArgs {
  installationId: string;
  webhookSecret: string;
  componentIdentityKey: string;
  callbackUrl: string;
  endpoint: string;
}

export async function initializeHandler(ctx: MutationCtx, args: InitializeArgs) {
  const existing = await currentIntegration(ctx);
  if (existing) {
    if (
      existing.state === "pending" &&
      existing.callbackUrl !== args.callbackUrl &&
      !isCanonicalCallbackUrl(existing.callbackUrl)
    ) {
      await ctx.db.patch(existing._id, { callbackUrl: args.callbackUrl });
      return currentIntegration(ctx);
    }
    return existing;
  }
  await ctx.db.insert("integrations", {
    key: CURRENT_KEY,
    ...args,
    announcedVersion: 0,
    state: "pending",
  });
  return currentIntegration(ctx);
}

function currentIntegration(ctx: MutationCtx) {
  return ctx.db
    .query("integrations")
    .withIndex("by_key", (q) => q.eq("key", CURRENT_KEY))
    .unique();
}
