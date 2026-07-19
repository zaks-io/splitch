export interface PanelDelegationReplayStore {
  consume(nonce: string, expiresAt: number, nowSeconds: number): Promise<boolean>;
}

interface PanelDelegationReplayStub {
  consume(expiresAt: number, nowSeconds: number): Promise<boolean>;
}

export interface PanelDelegationReplayDurableObjectNamespace {
  getByName(name: string): PanelDelegationReplayStub;
}

export function makePanelDelegationReplayStore(
  namespace: PanelDelegationReplayDurableObjectNamespace,
): PanelDelegationReplayStore {
  return {
    consume(nonce, expiresAt, nowSeconds) {
      return namespace.getByName(nonce).consume(expiresAt, nowSeconds);
    },
  };
}
