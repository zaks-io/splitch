import type {
  ApprovalArchiveEvent,
  ApprovalArchiveQuery,
  ApprovalArchiveStore,
} from "../src/approval-archive";

export class MemoryApprovalArchiveStore implements ApprovalArchiveStore {
  readonly events = new Map<string, ApprovalArchiveEvent>();
  readonly pendingEvents = new Map<string, ApprovalArchiveEvent>();
  appendCalls = 0;
  getCalls = 0;
  listCalls = 0;
  appendError: Error | null = null;
  listError: Error | null = null;
  acknowledgeAppend: (event: ApprovalArchiveEvent) => Promise<void> = () => Promise.resolve();
  mutateRead: ((event: ApprovalArchiveEvent) => ApprovalArchiveEvent) | null = null;

  async append(event: ApprovalArchiveEvent): Promise<void> {
    this.appendCalls += 1;
    if (this.appendError) throw this.appendError;
    const prior = this.events.get(event.dedup_key) ?? this.pendingEvents.get(event.dedup_key);
    if (prior && prior.archive_checksum !== event.archive_checksum) {
      throw new Error(`archive dedup conflict for ${event.dedup_key}`);
    }
    const pending = structuredClone(event);
    this.pendingEvents.set(event.dedup_key, pending);
    try {
      await this.acknowledgeAppend(structuredClone(event));
      this.events.set(event.dedup_key, pending);
    } finally {
      this.pendingEvents.delete(event.dedup_key);
    }
  }

  async get(
    appId: string,
    requestId: string,
    archiveVersion: number,
  ): Promise<ApprovalArchiveEvent | null> {
    this.getCalls += 1;
    const event = this.events.get(`${requestId}:${archiveVersion}`);
    if (!event || event.app_id !== appId) return null;
    const clone = structuredClone(event);
    return this.mutateRead ? this.mutateRead(clone) : clone;
  }

  async list(query: ApprovalArchiveQuery): Promise<ApprovalArchiveEvent[]> {
    this.listCalls += 1;
    if (this.listError) throw this.listError;
    return [...this.events.values()]
      .filter((event) => matches(event, query))
      .sort((left, right) => {
        if (left.proposed_at !== right.proposed_at) {
          return left.proposed_at > right.proposed_at ? -1 : 1;
        }
        return left.resource_id > right.resource_id ? -1 : 1;
      })
      .slice(0, query.limit)
      .map((event) => structuredClone(event));
  }
}

function matches(event: ApprovalArchiveEvent, query: ApprovalArchiveQuery): boolean {
  if (event.app_id !== query.appId) return false;
  if (query.requestId && event.resource_id !== query.requestId) return false;
  if (query.status && event.request_status !== query.status) return false;
  if (query.targetType && event.target_type !== query.targetType) return false;
  return matchesEnvironment(event, query.environmentId) && followsCursor(event, query.after);
}

function matchesEnvironment(event: ApprovalArchiveEvent, environmentId: string | undefined) {
  if (!environmentId) return true;
  const contexts = JSON.parse(event.policy_contexts) as Array<{ environmentId?: string }>;
  return contexts.some((context) => context.environmentId === environmentId);
}

function followsCursor(
  event: ApprovalArchiveEvent,
  after: { proposedAt: string; id: string } | undefined,
) {
  if (!after) return true;
  if (event.proposed_at !== after.proposedAt) return event.proposed_at < after.proposedAt;
  return event.resource_id < after.id;
}
