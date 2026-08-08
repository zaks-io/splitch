import type { ApprovalRequest } from "@splitch/contracts";
import { appScope, type Repository } from "@splitch/db";
import { canonicalHash, canonicalJson } from "./approval-canonical";
import { type RequestRow, type ReviewRow, storedApprovalRequestProjection } from "./approval-model";

export const APPROVAL_ARCHIVE_VERSION = 1;
const APPROVAL_ARCHIVE_RETENTION_DAYS = 90;

interface ApprovalArchivePayload {
  archiveVersion: typeof APPROVAL_ARCHIVE_VERSION;
  request: RequestRow;
  reviews: ReviewRow[];
}

export interface ApprovalArchiveEvent {
  audit_id: string;
  dedup_key: string;
  app_id: string;
  user_id: string;
  auth_method: string;
  action: "approval_request.archive";
  resource_type: "approval_request";
  resource_id: string;
  changes: string;
  timestamp: string;
  archive_version: typeof APPROVAL_ARCHIVE_VERSION;
  archive_row_count: number;
  archive_checksum: string;
  request_status: "applied" | "declined" | "stale";
  target_type: string;
  proposed_at: string;
  resolved_at: string;
  policy_contexts: string;
}

export interface ApprovalArchiveQuery {
  appId: string;
  requestId?: string;
  status?: string;
  targetType?: string;
  environmentId?: string;
  after?: { proposedAt: string; id: string };
  limit: number;
}

export interface ApprovalArchiveStore {
  append(event: ApprovalArchiveEvent): Promise<void>;
  get(
    appId: string,
    requestId: string,
    archiveVersion: number,
  ): Promise<ApprovalArchiveEvent | null>;
  list(query: ApprovalArchiveQuery): Promise<ApprovalArchiveEvent[]>;
}

export async function runApprovalRequestArchival(input: {
  repo: Repository;
  store: ApprovalArchiveStore;
  now?: Date;
  limit?: number;
}): Promise<number> {
  const now = input.now ?? new Date();
  const resolvedBefore = new Date(
    now.getTime() - APPROVAL_ARCHIVE_RETENTION_DAYS * 24 * 60 * 60 * 1_000,
  ).toISOString();
  const candidates = await input.repo.approvals.listArchiveCandidates(
    resolvedBefore,
    input.limit ?? 100,
  );
  let archived = 0;
  const failures: Array<{ requestId: string; error: unknown }> = [];
  for (const request of candidates) {
    try {
      await archiveCandidate(input.repo, input.store, request, now.toISOString());
      archived += 1;
    } catch (error) {
      failures.push({ requestId: request.id, error });
    }
  }
  if (failures.length > 0) {
    const details = failures
      .map(({ requestId, error }) => `${requestId}: ${fullError(error)}`)
      .join("\n");
    throw new AggregateError(
      failures.map(({ error }) => error),
      `Approval Request archival failed for ${failures.length} candidate(s):\n${details}`,
    );
  }
  return archived;
}

function fullError(error: unknown): string {
  if (error instanceof Error) {
    const rendered = error.stack ?? `${error.name}: ${error.message}`;
    return error.cause === undefined
      ? rendered
      : `${rendered}\nCaused by: ${fullError(error.cause)}`;
  }
  if (typeof error === "string") return error;
  try {
    return canonicalJson(error);
  } catch {
    return String(error);
  }
}

async function archiveCandidate(
  repo: Repository,
  store: ApprovalArchiveStore,
  request: RequestRow,
  archivedAt: string,
): Promise<void> {
  const status = terminalStatus(request.status);
  if (!request.resolvedAt) {
    throw new Error(`Terminal Approval Request ${request.id} is missing resolved_at`);
  }
  const reviews = await repo.approvals.listReviews(appScope(request.appId), request.id);
  const event = await approvalArchiveEvent(request, reviews, archivedAt);
  const existing = await store.get(request.appId, request.id, APPROVAL_ARCHIVE_VERSION);
  if (!existing) await store.append(event);
  const stored = existing ?? (await store.get(request.appId, request.id, APPROVAL_ARCHIVE_VERSION));
  if (!stored) {
    throw new Error(`Approval Request ${request.id} archive verification returned no row`);
  }
  await verifiedArchivePayload(stored, request.appId, request.id);
  assertVerifiedEvent(stored, event);
  await repo.approvals.finalizeArchive(
    appScope(request.appId),
    {
      requestId: request.id,
      resolvedAt: request.resolvedAt,
      reviewCount: reviews.length,
    },
    status,
  );
}

function assertVerifiedEvent(stored: ApprovalArchiveEvent, expected: ApprovalArchiveEvent): void {
  if (
    stored.archive_version !== expected.archive_version ||
    stored.archive_row_count !== expected.archive_row_count ||
    stored.archive_checksum !== expected.archive_checksum
  ) {
    throw new Error(`Approval Request ${expected.resource_id} archive verification mismatch`);
  }
}

export async function approvalArchiveEvent(
  request: RequestRow,
  reviews: ReviewRow[],
  archivedAt: string,
): Promise<ApprovalArchiveEvent> {
  const status = terminalStatus(request.status);
  if (!request.resolvedAt) {
    throw new Error(`Terminal Approval Request ${request.id} is missing resolved_at`);
  }
  assertOrderedReviews(reviews);
  const payload: ApprovalArchivePayload = {
    archiveVersion: APPROVAL_ARCHIVE_VERSION,
    request: { ...request },
    reviews: reviews.map((review) => ({ ...review })),
  };
  const changes = canonicalJson(payload);
  const checksum = await canonicalHash(payload);
  return {
    audit_id: crypto.randomUUID(),
    dedup_key: `${request.id}:${APPROVAL_ARCHIVE_VERSION}`,
    app_id: request.appId,
    user_id: request.proposedBy,
    auth_method: request.proposedVia,
    action: "approval_request.archive",
    resource_type: "approval_request",
    resource_id: request.id,
    changes,
    timestamp: archivedAt,
    archive_version: APPROVAL_ARCHIVE_VERSION,
    archive_row_count: 1 + reviews.length,
    archive_checksum: checksum,
    request_status: status,
    target_type: request.targetType,
    proposed_at: request.proposedAt,
    resolved_at: request.resolvedAt,
    policy_contexts: canonicalJson(JSON.parse(request.policyContexts)),
  };
}

async function verifiedArchivePayload(
  event: ApprovalArchiveEvent,
  appId: string,
  requestId: string,
): Promise<ApprovalArchivePayload> {
  if (event.app_id !== appId || event.resource_id !== requestId) {
    throw new Error("Approval Request archive crossed its App scope");
  }
  if (
    event.action !== "approval_request.archive" ||
    event.resource_type !== "approval_request" ||
    event.dedup_key !== `${requestId}:${event.archive_version}`
  ) {
    throw new Error(`Approval Request ${requestId} archive identity mismatch`);
  }
  const payload = parsePayload(event.changes);
  if (payload.archiveVersion !== event.archive_version) {
    throw new Error(`Approval Request ${requestId} archive version mismatch`);
  }
  if (1 + payload.reviews.length !== event.archive_row_count) {
    throw new Error(`Approval Request ${requestId} archive row-count mismatch`);
  }
  if ((await canonicalHash(payload)) !== event.archive_checksum) {
    throw new Error(`Approval Request ${requestId} archive checksum mismatch`);
  }
  if (payload.request.appId !== appId || payload.request.id !== requestId) {
    throw new Error("Approval Request archive payload crossed its App scope");
  }
  assertOrderedReviews(payload.reviews);
  return payload;
}

export async function archivedApprovalRequest(
  event: ApprovalArchiveEvent,
): Promise<ApprovalRequest> {
  const payload = await verifiedArchivePayload(event, event.app_id, event.resource_id);
  return storedApprovalRequestProjection(payload.request, payload.reviews.at(-1) ?? null);
}

function parsePayload(changes: string): ApprovalArchivePayload {
  let value: unknown;
  try {
    value = JSON.parse(changes);
  } catch (cause) {
    throw new Error("Approval Request archive payload is not JSON", { cause });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Approval Request archive payload is malformed");
  }
  const record = value as Partial<ApprovalArchivePayload>;
  if (
    typeof record.archiveVersion !== "number" ||
    !Number.isSafeInteger(record.archiveVersion) ||
    !record.request ||
    typeof record.request !== "object" ||
    !Array.isArray(record.reviews)
  ) {
    throw new Error("Approval Request archive payload is malformed");
  }
  return record as ApprovalArchivePayload;
}

function assertOrderedReviews(reviews: ReviewRow[]): void {
  for (let index = 1; index < reviews.length; index += 1) {
    const previous = reviews[index - 1];
    const current = reviews[index];
    if (!previous || !current) throw new Error("Approval Request archive Review is missing");
    if (
      previous.reviewedAt > current.reviewedAt ||
      (previous.reviewedAt === current.reviewedAt && previous.id >= current.id)
    ) {
      throw new Error("Approval Request archive Reviews are not in canonical order");
    }
  }
}

function terminalStatus(value: string): "applied" | "declined" | "stale" {
  if (value === "applied" || value === "declined" || value === "stale") return value;
  throw new Error(`Approval Request archival refused non-terminal status ${value}`);
}
