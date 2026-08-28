import type { DelegatedIdentity } from "@splitch/worker-runtime";
import { entityStub } from "./entity-metric-privacy";
import type { Env } from "./types";

export async function handleEntityMetricPrivacy(
  request: Request,
  env: Env,
  identity: DelegatedIdentity,
  operation: "export" | "suppress" | "delete",
): Promise<Response> {
  const appId = pathAppId(request);
  if (identity.appId !== appId) return new Response("forbidden", { status: 403 });
  const body = await privacyBody(request);
  const stub = entityStub(env.ENTITY_METRIC_PRIVACY, {
    appId,
    idType: body.idType,
    entityFamilyHash: body.entityFamilyHash,
  });
  const response = await stub.fetch(`https://entity-privacy.local/${operation}`, {
    method: operation === "export" ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    ...(operation === "export"
      ? {}
      : { body: JSON.stringify({ deleteBeforeTs: body.deleteBeforeTs }) }),
  });
  if (!response.ok)
    return new Response("Entity Metric privacy store is unavailable", { status: 503 });
  const result = (await response.json()) as { records?: unknown; proofs?: unknown };
  if (!Array.isArray(result.proofs) || result.proofs.some((proof) => typeof proof !== "string")) {
    return new Response("Entity Metric privacy store returned invalid proof", { status: 503 });
  }
  if (operation === "export" && !Array.isArray(result.records)) {
    return new Response("Entity Metric privacy store returned invalid export", { status: 503 });
  }
  return Response.json({
    appId,
    idType: body.idType,
    targetingKeyHashes: body.targetingKeyHashes,
    entityFamilyHash: body.entityFamilyHash,
    ...(operation === "export" ? { records: result.records } : {}),
    proofs: result.proofs,
  });
}

export function requireEntityMetricPrivacyBinding(env: Env): void {
  if (
    !env.ENTITY_METRIC_PRIVACY &&
    env.SPLITCH_PLATFORM_TARGET !== "local" &&
    env.SPLITCH_PLATFORM_TARGET !== "pr-ci"
  ) {
    throw new Error("ENTITY_METRIC_PRIVACY binding is unavailable");
  }
}

function pathAppId(request: Request): string {
  const match = /^\/internal\/apps\/([^/]+)\/entity-events\/(?:export|suppress|delete)$/u.exec(
    new URL(request.url).pathname,
  );
  if (!match?.[1]) throw new Error("Entity Metric privacy path is invalid");
  return decodeURIComponent(match[1]);
}

async function privacyBody(request: Request): Promise<{
  idType: string;
  targetingKeyHashes: string[];
  entityFamilyHash: string;
  deleteBeforeTs?: string;
}> {
  const body = (await request.json()) as Record<string, unknown>;
  const keys = Object.keys(body).sort();
  const allowed = ["deleteBeforeTs", "entityFamilyHash", "idType", "targetingKeyHashes"];
  if (keys.some((key) => !allowed.includes(key)))
    throw new Error("Entity Metric privacy body is ambiguous");
  if (
    typeof body.idType !== "string" ||
    typeof body.entityFamilyHash !== "string" ||
    !Array.isArray(body.targetingKeyHashes) ||
    body.targetingKeyHashes.length === 0 ||
    body.targetingKeyHashes.some((hash) => typeof hash !== "string") ||
    (body.deleteBeforeTs !== undefined && typeof body.deleteBeforeTs !== "string")
  ) {
    throw new Error("Entity Metric privacy body is invalid");
  }
  return {
    idType: body.idType,
    entityFamilyHash: body.entityFamilyHash,
    targetingKeyHashes: body.targetingKeyHashes as string[],
    ...(typeof body.deleteBeforeTs === "string" ? { deleteBeforeTs: body.deleteBeforeTs } : {}),
  };
}
