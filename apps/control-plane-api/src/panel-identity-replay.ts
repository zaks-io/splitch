const REPLAY_PREFIX = "control-panel-identity:";

export interface PanelIdentityReplayStore {
  consume(nonce: string, expiresAt: number, nowSeconds: number): Promise<boolean>;
}

/** Consume a binding identity once. KV faults propagate so authorization fails loud. */
export function makePanelIdentityReplayStore(kv: KVNamespace): PanelIdentityReplayStore {
  return {
    async consume(nonce, expiresAt, nowSeconds) {
      if (expiresAt <= nowSeconds) return false;
      const key = `${REPLAY_PREFIX}${nonce}`;
      if (await kv.get(key)) return false;
      await kv.put(key, "used", { expirationTtl: Math.max(60, expiresAt - nowSeconds) });
      return true;
    },
  };
}
