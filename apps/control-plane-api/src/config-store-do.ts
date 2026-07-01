import type { DeltaNudge } from "@splitch/contracts";
import { createRepository } from "@splitch/db";
import { DurableObject } from "cloudflare:workers";
import { makeConfigStore, type ConfigStoreWriter } from "./config-store.js";
import type { ControlPlaneApiEnv } from "./env.js";

export interface ConfigStoreDurableObjectNamespace {
  getByName(name: string): ConfigStoreDurableObjectStub;
}

interface ConfigStoreDurableObjectStub extends ConfigStoreWriter {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

interface ConfigStoreLiveUpdates {
  connect(request: Request): Promise<Response>;
}

export interface ConfigStoreAccess {
  writerFor(appId: string, environmentId: string): ConfigStoreWriter;
  liveUpdatesFor(appId: string, environmentId: string): ConfigStoreLiveUpdates;
}

function configWriterName(appId: string, environmentId: string): string {
  return `${appId}:${environmentId}`;
}

export function durableConfigStoreAccess(
  namespace: ConfigStoreDurableObjectNamespace,
): ConfigStoreAccess {
  return {
    writerFor(appId, environmentId) {
      return namespace.getByName(configWriterName(appId, environmentId));
    },
    liveUpdatesFor(appId, environmentId) {
      return {
        connect(request) {
          return namespace.getByName(configWriterName(appId, environmentId)).fetch(request);
        },
      };
    },
  };
}

export class ConfigStoreDurableObject
  extends DurableObject<ControlPlaneApiEnv>
  implements ConfigStoreWriter
{
  readFlagConfig(
    input: Parameters<ConfigStoreWriter["readFlagConfig"]>[0],
  ): ReturnType<ConfigStoreWriter["readFlagConfig"]> {
    return this.store().readFlagConfig(input);
  }

  writeFlagConfig(
    input: Parameters<ConfigStoreWriter["writeFlagConfig"]>[0],
  ): ReturnType<ConfigStoreWriter["writeFlagConfig"]> {
    return this.store().writeFlagConfig(input);
  }

  override fetch(request: Request): Response {
    if (request.method !== "GET" || request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected WebSocket upgrade", { status: 426 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  override webSocketMessage(): void {}

  override webSocketClose(): void {}

  override webSocketError(): void {}

  private store(): ConfigStoreWriter {
    return makeConfigStore({
      repo: createRepository(this.env.DB),
      kv: this.env.CONFIG_STORE,
      broadcaster: { broadcast: (nudge) => this.broadcast(nudge) },
      logger: console,
    });
  }

  private broadcast(nudge: DeltaNudge): void {
    const payload = JSON.stringify(nudge);
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(payload);
      } catch (cause) {
        console.warn("config_store_live_update_send_failed", { cause });
      }
    }
  }
}
