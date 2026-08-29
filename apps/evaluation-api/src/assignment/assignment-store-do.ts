import { DurableObject } from "cloudflare:workers";
import type { AssignmentKv } from "./assignment-store";
import { parseHashedAssignmentPut } from "./assignment-store-input";
import { AssignmentStoreWriter } from "./assignment-store-writer";

export interface AssignmentStoreEnv {
  ASSIGNMENTS_KV: AssignmentKv;
}

export class AssignmentStoreDurableObject extends DurableObject<AssignmentStoreEnv> {
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/export") {
      const writer = new AssignmentStoreWriter(
        this.ctx.storage,
        this.env.ASSIGNMENTS_KV,
        (promise) => this.ctx.waitUntil(promise),
      );
      return Response.json(await this.ctx.blockConcurrencyWhile(() => writer.exportEntity()));
    }
    if (request.method !== "POST" || (url.pathname !== "/put" && url.pathname !== "/delete")) {
      return Response.json({ error: "not found" }, { status: 404 });
    }

    const writer = new AssignmentStoreWriter(this.ctx.storage, this.env.ASSIGNMENTS_KV, (promise) =>
      this.ctx.waitUntil(promise),
    );
    if (url.pathname === "/delete") {
      const proof = await this.ctx.blockConcurrencyWhile(() => writer.deleteEntity());
      return Response.json({ deleted: true, proof });
    }

    const input = parseHashedAssignmentPut(await request.json());
    const result = await this.ctx.blockConcurrencyWhile(() => writer.put(input));
    return Response.json(result);
  }
}
