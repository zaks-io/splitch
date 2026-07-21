import type { McpDelegationReplayGuard } from "@splitch/contracts";

const CLAIM_PATH = "/claim";
const CLAIM_KEY = "claimed-until";
const MAX_CLAIM_TTL_SECONDS = 35;

interface ReplayDurableObjectStub {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export interface McpDelegationReplayDurableObjectNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): ReplayDurableObjectStub;
}

export function makeDurableMcpDelegationReplayGuard(
  namespace: McpDelegationReplayDurableObjectNamespace,
): McpDelegationReplayGuard {
  return {
    async claim(jti, expiresAt, nowSeconds) {
      const response = await namespace
        .get(namespace.idFromName(jti))
        .fetch(`https://mcp-delegation-replay.local${CLAIM_PATH}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ expiresAt, nowSeconds }),
        });
      if (response.status === 409) return false;
      if (response.status !== 201) {
        throw new Error(`worker-runtime: MCP delegation replay claim failed (${response.status})`);
      }
      return true;
    },
  };
}

export class McpDelegationReplayDurableObject {
  constructor(private readonly ctx: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST" || new URL(request.url).pathname !== CLAIM_PATH) {
      return new Response("not found", { status: 404 });
    }
    const claim = await parseClaim(request);
    if (!claim) return new Response("invalid claim", { status: 400 });

    return this.ctx.blockConcurrencyWhile(async () => {
      if ((await this.ctx.storage.get(CLAIM_KEY)) !== undefined) {
        return new Response("replayed", { status: 409 });
      }
      await this.ctx.storage.put(CLAIM_KEY, claim.expiresAt);
      await this.ctx.storage.setAlarm(claim.expiresAt * 1000);
      return new Response(null, { status: 201 });
    });
  }

  async alarm(): Promise<void> {
    const expiresAt = await this.ctx.storage.get<number>(CLAIM_KEY);
    if (expiresAt === undefined || expiresAt * 1000 <= Date.now()) {
      await this.ctx.storage.deleteAll();
      return;
    }
    await this.ctx.storage.setAlarm(expiresAt * 1000);
  }
}

async function parseClaim(
  request: Request,
): Promise<{ expiresAt: number; nowSeconds: number } | null> {
  try {
    const value = (await request.json()) as Record<string, unknown>;
    const { expiresAt, nowSeconds } = value;
    if (
      typeof expiresAt !== "number" ||
      !Number.isInteger(expiresAt) ||
      typeof nowSeconds !== "number" ||
      !Number.isInteger(nowSeconds) ||
      expiresAt <= nowSeconds ||
      expiresAt > nowSeconds + MAX_CLAIM_TTL_SECONDS
    ) {
      return null;
    }
    return { expiresAt, nowSeconds };
  } catch {
    return null;
  }
}
