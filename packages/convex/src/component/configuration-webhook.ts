import { readBoundedRequestBody } from "@splitch/bounded-body";
import {
  ConfigurationCallbackVerificationSchema,
  ConvexConfigChangedSchema,
  parseResponseTolerantly,
} from "@splitch/sdk/local-evaluation";
import { constantTimeEqual, hmacHex } from "./crypto";

export const CONVEX_WEBHOOK_MAX_BODY_BYTES = 32 * 1024;

interface ConfigurationWebhookIntegration {
  readonly installationId: string;
  readonly webhookSecret: string;
  readonly previousWebhookSecret?: string;
}

export interface ConfigurationWebhookDeps {
  nowSeconds(): number;
  getIntegration(): Promise<ConfigurationWebhookIntegration | null>;
  announce(args: {
    deliveryId: string;
    appId: string;
    environmentId: string;
    environmentVersion: number;
  }): Promise<void>;
}

export async function handleConfigurationWebhook(
  request: Request,
  deps: ConfigurationWebhookDeps,
): Promise<Response> {
  const bounded = await readBoundedRequestBody(request, {
    maxBytes: CONVEX_WEBHOOK_MAX_BODY_BYTES,
    allowedMediaTypes: ["application/json"],
  });
  if (!bounded.ok) return new Response("invalid body", { status: 400 });

  const timestamp = request.headers.get("splitch-timestamp");
  const signature = request.headers.get("splitch-signature");
  if (!timestamp || !signature?.startsWith("v1="))
    return new Response("invalid signature", { status: 401 });
  const seconds = Number(timestamp);
  if (!Number.isInteger(seconds) || Math.abs(deps.nowSeconds() - seconds) > 300)
    return new Response("expired signature", { status: 401 });

  const body = bounded.text;
  const integration = await deps.getIntegration();
  if (!integration) return new Response("not installed", { status: 409 });
  const authenticatedSecret = await authenticateSecret(
    integration,
    `${timestamp}.${body}`,
    signature.slice(3),
  );
  if (!authenticatedSecret) return new Response("invalid signature", { status: 401 });
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return new Response("invalid body", { status: 400 });
  }
  return handleAuthenticatedBody(request, deps, integration, parsed, authenticatedSecret);
}

async function authenticateSecret(
  integration: ConfigurationWebhookIntegration,
  message: string,
  signature: string,
): Promise<"current" | "previous" | null> {
  const current = await hmacHex(integration.webhookSecret, message);
  if (constantTimeEqual(signature, current)) return "current";
  if (integration.previousWebhookSecret) {
    const previous = await hmacHex(integration.previousWebhookSecret, message);
    if (constantTimeEqual(signature, previous)) return "previous";
  }
  return null;
}

async function handleAuthenticatedBody(
  request: Request,
  deps: ConfigurationWebhookDeps,
  integration: ConfigurationWebhookIntegration,
  parsed: unknown,
  authenticatedSecret: "current" | "previous",
): Promise<Response> {
  const verification = ConfigurationCallbackVerificationSchema.safeParse(parsed);
  if (verification.success) {
    if (authenticatedSecret !== "current")
      return new Response("invalid signature", { status: 401 });
    if (verification.data.installationId !== integration.installationId)
      return new Response("installation ID mismatch", { status: 400 });
    const proof = await hmacHex(
      integration.webhookSecret,
      `callback.verify:${verification.data.installationId}:${verification.data.challenge}`,
    );
    return new Response(null, { status: 204, headers: { "splitch-callback-proof": proof } });
  }
  const changed = parseResponseTolerantly(ConvexConfigChangedSchema, parsed);
  if (!changed.success) return new Response("invalid body", { status: 400 });
  if (request.headers.get("splitch-delivery-id") !== changed.data.deliveryId)
    return new Response("delivery ID mismatch", { status: 400 });
  await deps.announce({
    deliveryId: changed.data.deliveryId,
    appId: changed.data.appId,
    environmentId: changed.data.environmentId,
    environmentVersion: changed.data.environmentVersion,
  });
  return new Response(null, { status: 202 });
}
