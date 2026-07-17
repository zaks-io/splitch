import { createRepository } from "@splitch/db";
import { DurableObject } from "cloudflare:workers";
import { backfillCredentialCaches } from "./credential-cache";
import { durableCredentialCacheWriterAccess } from "./credential-cache-writer-do";
import type { ControlPlaneApiEnv } from "./env";

const BATCH_SIZE = 25;
const NEXT_BATCH_DELAY_MS = 1_000;
const CHECKPOINT_KEY = "credential-cache-backfill-checkpoint";

interface Checkpoint {
  kind: "client" | "api" | "done";
  afterKeyId?: string;
}

export interface CredentialCacheBackfillDurableObjectNamespace {
  getByName(name: string): {
    fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  };
}

/** Durable, bounded migration of legacy cache rows. One alarm processes one keyset page. */
export class CredentialCacheBackfillDurableObject extends DurableObject<ControlPlaneApiEnv> {
  override async fetch(): Promise<Response> {
    await this.runBatch();
    return new Response(null, { status: 204 });
  }

  override async alarm(): Promise<void> {
    await this.runBatch();
  }

  private async runBatch(): Promise<void> {
    const checkpoint = (await this.ctx.storage.get<Checkpoint>(CHECKPOINT_KEY)) ?? {
      kind: "client",
    };
    if (checkpoint.kind === "done") return;
    const credentials = createRepository(this.env.DB).credentials;
    const writer = {
      credentialCacheWriter: durableCredentialCacheWriterAccess(this.env.CREDENTIAL_CACHE_WRITER),
    };
    if (checkpoint.kind === "client") {
      const rows = await credentials.listClientKeysForCacheBackfill(
        checkpoint.afterKeyId,
        BATCH_SIZE,
      );
      await backfillCredentialCaches(writer, { clientKeys: rows, apiKeys: [] });
      await this.advance(checkpoint, rows.at(-1)?.keyId);
      return;
    }
    const rows = await credentials.listApiKeysForCacheBackfill(checkpoint.afterKeyId, BATCH_SIZE);
    await backfillCredentialCaches(writer, { clientKeys: [], apiKeys: rows });
    await this.advance(checkpoint, rows.at(-1)?.keyId);
  }

  private async advance(checkpoint: Checkpoint, lastKeyId: string | undefined): Promise<void> {
    if (lastKeyId !== undefined) {
      await this.ctx.storage.put(CHECKPOINT_KEY, { kind: checkpoint.kind, afterKeyId: lastKeyId });
      await this.ctx.storage.setAlarm(Date.now() + NEXT_BATCH_DELAY_MS);
      return;
    }
    if (checkpoint.kind === "client") {
      await this.ctx.storage.put(CHECKPOINT_KEY, { kind: "api" } satisfies Checkpoint);
      await this.ctx.storage.setAlarm(Date.now() + NEXT_BATCH_DELAY_MS);
      return;
    }
    await this.ctx.storage.put(CHECKPOINT_KEY, { kind: "done" } satisfies Checkpoint);
  }
}
