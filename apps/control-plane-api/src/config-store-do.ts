import type { DeltaNudge } from "@splitch/contracts";
import { createRepository } from "@splitch/db";
import { DurableObject } from "cloudflare:workers";
import { makeConfigStore, type ConfigStoreWriter } from "./config-store.js";
import type { ControlPlaneApiEnv } from "./env.js";

export interface ConfigStoreDurableObjectNamespace {
  getByName(name: string): unknown;
}

export interface ConfigStoreAccess {
  writerFor(appId: string, environmentId: string): ConfigStoreWriter;
}

function configWriterName(appId: string, environmentId: string): string {
  return `${appId}:${environmentId}`;
}

export function durableConfigStoreAccess(
  namespace: ConfigStoreDurableObjectNamespace,
): ConfigStoreAccess {
  return {
    writerFor(appId, environmentId) {
      return namespace.getByName(configWriterName(appId, environmentId)) as ConfigStoreWriter;
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
    const state = this.ctx as DurableObjectState & {
      getWebSockets?: () => WebSocket[];
    };
    for (const socket of state.getWebSockets?.() ?? []) {
      socket.send(payload);
    }
  }
}
