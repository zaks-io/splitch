import { httpRouter } from "convex/server";
import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";
import { handleConfigurationWebhook } from "./configuration-webhook";

const http = httpRouter();

http.route({
  path: "/configuration",
  method: "POST",
  handler: httpAction(async (ctx, request) =>
    handleConfigurationWebhook(request, {
      nowSeconds: () => Date.now() / 1000,
      getIntegration: () => ctx.runQuery(internal.integration.get, {}),
      announce: async (args) => {
        await ctx.runMutation(internal.integration.announce, args);
      },
    }),
  ),
});

export default http;
