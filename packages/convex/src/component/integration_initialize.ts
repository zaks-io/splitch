import { configurationCallbackUrlError } from "@splitch/sdk/local-evaluation";
import type { Doc } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { CURRENT_KEY } from "./integration_state";

interface InitializeArgs {
  installationId: string;
  webhookSecret: string;
  componentIdentityKey: string;
  callbackUrl: string;
  endpoint: string;
}

function needsCallbackRepair(existing: Doc<"integrations">): boolean {
  return (
    existing.state === "pending" && configurationCallbackUrlError(existing.callbackUrl) !== null
  );
}

export function installCallbackUrl(
  existing: Doc<"integrations"> | null,
  derive: () => string,
): string {
  return existing && !needsCallbackRepair(existing) ? existing.callbackUrl : derive();
}

export async function initializeHandler(ctx: MutationCtx, args: InitializeArgs) {
  const existing = await currentIntegration(ctx);
  if (existing) {
    if (needsCallbackRepair(existing) && existing.callbackUrl !== args.callbackUrl) {
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
