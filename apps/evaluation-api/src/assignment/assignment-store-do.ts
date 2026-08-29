import { DurableObject } from "cloudflare:workers";
import { requireDestroyedIdentityVersions } from "./app-identity-reset-fence";
import type { AssignmentKv } from "./assignment-store";
import { parseHashedAssignmentPut } from "./assignment-store-input";
import { AssignmentStoreWriter } from "./assignment-store-writer";

export interface AssignmentStoreEnv {
  ASSIGNMENTS_KV: AssignmentKv;
}

export class AssignmentStoreDurableObjectV2 extends DurableObject<AssignmentStoreEnv> {
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/export") {
      return Response.json(
        await this.ctx.blockConcurrencyWhile(() => this.writer().exportEntity()),
      );
    }
    if (request.method === "POST") return this.post(url.pathname, request);
    return Response.json({ error: "not found" }, { status: 404 });
  }

  private async post(path: string, request: Request): Promise<Response> {
    if (path === "/put") {
      const input = parseHashedAssignmentPut(await request.json());
      const result = await this.ctx.blockConcurrencyWhile(() => this.writer().put(input));
      return Response.json(result);
    }
    if (path !== "/delete" && path !== "/reset-app") {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    return this.delete(path, (await request.json()) as Record<string, unknown>);
  }

  private async delete(path: string, body: Record<string, unknown>): Promise<Response> {
    const identity = assignmentIdentity(body);
    if (identity === null) {
      return Response.json({ error: "Assignment identity is required" }, { status: 400 });
    }
    if (path === "/reset-app") {
      const proof = await this.ctx.blockConcurrencyWhile(() =>
        this.writer().resetApp(identity, requireDestroyedIdentityVersions(body.destroyedVersions)),
      );
      return Response.json({ deleted: true, ...proof });
    }
    if (typeof body.deleteBeforeTsMs !== "number" || !Number.isFinite(body.deleteBeforeTsMs)) {
      return Response.json({ error: "deleteBeforeTsMs is required" }, { status: 400 });
    }
    const proof = await this.ctx.blockConcurrencyWhile(() =>
      this.writer().deleteEntity(identity, body.deleteBeforeTsMs as number),
    );
    return Response.json({ deleted: true, proof });
  }

  private writer(): AssignmentStoreWriter {
    return new AssignmentStoreWriter(this.ctx.storage, this.env.ASSIGNMENTS_KV, (promise) =>
      this.ctx.waitUntil(promise),
    );
  }
}

function assignmentIdentity(body: Record<string, unknown>): {
  appId: string;
  idType: string;
  targetingKeyHash: string;
} | null {
  return typeof body.appId === "string" &&
    typeof body.idType === "string" &&
    typeof body.targetingKeyHash === "string"
    ? { appId: body.appId, idType: body.idType, targetingKeyHash: body.targetingKeyHash }
    : null;
}
