export interface EvaluationCommit {
  readonly eventId: string;
  readonly payload: unknown;
  readonly delivered: boolean;
  readonly ready: boolean;
}

export interface EvaluationCommitOutbox {
  lookup(identity: string): Promise<EvaluationCommit | null>;
  commit(identity: string, payload: unknown): Promise<EvaluationCommit>;
  activate(identity: string): Promise<EvaluationCommit>;
  privacyExport(
    identity: string,
    eventIds: readonly string[],
  ): Promise<readonly Record<string, unknown>[]>;
  privacyDelete(identity: string, eventIds: readonly string[]): Promise<number>;
  privacyDeleteAll(identity: string): Promise<"evaluation-commit-outbox-purged-v1">;
}

export interface EvaluationCommitOutboxNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): {
    fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  };
}
