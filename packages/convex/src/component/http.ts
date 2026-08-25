import { ConvexConfigChangedSchema } from "@splitch/contracts";
import { httpRouter } from "convex/server";
import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";
import { constantTimeEqual, hmacHex } from "./crypto";

const http = httpRouter();

http.route({
  path: "/configuration",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const timestamp = request.headers.get("splitch-timestamp");
    const signature = request.headers.get("splitch-signature");
    if (!timestamp || !signature?.startsWith("v1="))
      return new Response("invalid signature", { status: 401 });
    const seconds = Number(timestamp);
    if (!Number.isInteger(seconds) || Math.abs(Date.now() / 1000 - seconds) > 300)
      return new Response("expired signature", { status: 401 });
    const body = await request.text();
    const integration = await ctx.runQuery(internal.integration.get, {});
    if (!integration) return new Response("not installed", { status: 409 });
    const expected = await Promise.all(
      [integration.webhookSecret, integration.previousWebhookSecret]
        .filter((secret): secret is string => typeof secret === "string")
        .map((secret) => hmacHex(secret, `${timestamp}.${body}`)),
    );
    if (!expected.some((candidate) => constantTimeEqual(signature.slice(3), candidate)))
      return new Response("invalid signature", { status: 401 });
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return new Response("invalid body", { status: 400 });
    }
    const changed = ConvexConfigChangedSchema.safeParse(parsed);
    if (!changed.success) return new Response("invalid body", { status: 400 });
    if (request.headers.get("splitch-delivery-id") !== changed.data.deliveryId)
      return new Response("delivery ID mismatch", { status: 400 });
    await ctx.runMutation(internal.integration.announce, changed.data);
    return new Response(null, { status: 202 });
  }),
});

export default http;
