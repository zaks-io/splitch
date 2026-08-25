export interface PanelDelegationReplayStore {
  consume(nonce: string, expiresAt: number, nowSeconds: number): Promise<boolean>;
}

interface PanelDelegationReplayStub {
  consume(nonce: string, expiresAt: number, nowSeconds: number): Promise<boolean>;
}

export interface PanelDelegationReplayDurableObjectNamespace {
  getByName(name: string): PanelDelegationReplayStub;
}

/**
 * A bounded set of shards rather than one object per nonce: first contact with a
 * never-before-seen Durable Object costs 500-900ms (placement + cold start),
 * which a fresh nonce per delegation would pay on every Panel call. A nonce
 * still maps to exactly one shard, so redemption stays linearizable per nonce
 * inside that shard's single thread.
 */
const REPLAY_SHARD_COUNT = 16;

export function replayShardName(nonce: string): string {
  let hash = 0;
  for (let index = 0; index < nonce.length; index++) {
    hash = (hash * 31 + nonce.charCodeAt(index)) >>> 0;
  }
  return `replay-shard-${hash % REPLAY_SHARD_COUNT}`;
}

export function makePanelDelegationReplayStore(
  namespace: PanelDelegationReplayDurableObjectNamespace,
): PanelDelegationReplayStore {
  return {
    consume(nonce, expiresAt, nowSeconds) {
      return namespace.getByName(replayShardName(nonce)).consume(nonce, expiresAt, nowSeconds);
    },
  };
}
