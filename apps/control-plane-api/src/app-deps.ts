import type { Repository } from "@splitch/db";
import type { AuthResolver, RateLimiter, RegistrarDeps } from "@splitch/worker-runtime";
import type { AnalysisResultsReader } from "./attention-analysis-reader";
import type { CloudflareHandlerDeps } from "./cloudflare-handlers";
import type { ConfigStoreAccess } from "./config-store-do";
import type { ConvexHandlerDeps } from "./convex-handlers";
import type { CredentialCacheWriterAccess } from "./credential-cache";
import type { DelegationBindings } from "./delegated-routes";
import type { EnvironmentExposureStatusCleanup } from "./environment-exposure-status-cleanup";
import type { HoldoverWriteOutboxCleanup } from "./holdover-write-outbox-cleanup";
import type { MembershipCacheInvalidator } from "./membership-cache";
import type { MemberProfileResolver } from "./org-handlers";

export interface AppDeps {
  door?: "public" | "binding";
  authResolver: AuthResolver;
  rateLimiter: RateLimiter;
  repo: Repository;
  credentialStore?: KVNamespace;
  credentialCacheWriter?: CredentialCacheWriterAccess;
  configStore?: ConfigStoreAccess;
  eventDefinitionStore?: KVNamespace;
  runSnapshotDelivery?: import("./run-snapshot").RunSnapshotDelivery;
  memberProfileResolver?: MemberProfileResolver;
  membershipCache?: MembershipCacheInvalidator;
  nowIso?: () => string;
  defaultHeaders?: Record<string, string>;
  observability?: RegistrarDeps["observability"];
  logger?: Pick<Console, "warn">;
  analysisResults?: AnalysisResultsReader;
  delegationBindings?: DelegationBindings;
  approvalArchiveStore?: import("./approval-archive").ApprovalArchiveStore;
  exposureStatusCleanup?: EnvironmentExposureStatusCleanup;
  holdoverWriteOutboxCleanup?: HoldoverWriteOutboxCleanup;
  convex?: Omit<ConvexHandlerDeps, "repo">;
  cloudflare?: Omit<CloudflareHandlerDeps, "repo">;
  sentry?: Omit<import("./sentry-handlers").SentryHandlerDeps, "repo">;
}
