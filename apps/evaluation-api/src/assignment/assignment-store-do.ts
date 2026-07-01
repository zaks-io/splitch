import { DurableObject } from "cloudflare:workers";
import type { AssignmentKv, HashedAssignmentPutInput } from "./assignment-store.js";
import { AssignmentStoreWriter } from "./assignment-store-writer.js";

export interface AssignmentStoreEnv {
  ASSIGNMENTS_KV: AssignmentKv;
}

export class AssignmentStoreDurableObject extends DurableObject<AssignmentStoreEnv> {
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/put") {
      return Response.json({ error: "not found" }, { status: 404 });
    }

    const input = parsePutRequest(await request.json());
    const result = await this.ctx.blockConcurrencyWhile(() =>
      new AssignmentStoreWriter(this.ctx.storage, this.env.ASSIGNMENTS_KV, (promise) =>
        this.ctx.waitUntil(promise),
      ).put(input),
    );
    return Response.json(result);
  }
}

function parsePutRequest(value: unknown): HashedAssignmentPutInput {
  if (!isRecord(value)) {
    throw new TypeError("assignment-store: expected object payload");
  }

  const input = {
    appId: requireString(value, "appId"),
    experimentId: requireString(value, "experimentId"),
    idType: requireString(value, "idType"),
    targetingKeyHash: requireString(value, "targetingKeyHash"),
    runId: requireString(value, "runId"),
    variant: requireString(value, "variant"),
  };

  const extra = Object.keys(value).filter((key) => !(key in input));
  if (extra.length > 0) {
    throw new TypeError(`assignment-store: unexpected payload keys ${extra.join(",")}`);
  }
  return input;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== "string" || field.length === 0) {
    throw new TypeError(`assignment-store: ${key} must be a non-empty string`);
  }
  return field;
}
