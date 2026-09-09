import { and, desc, eq } from "drizzle-orm";
import { conclusionApprovalRequests, experimentConclusions } from "../schema/index";
import type { Db } from "./client";
import {
  type CommitConclusionInput,
  type CreateReplacementPromotionInput,
  conclusionStatements,
  replacementStatements,
} from "./experiment-conclusion-atomic";
import { assertMintedScope, type EnvScope, type TenantScope } from "./scope";

export type { CommitConclusionInput, CreateReplacementPromotionInput };

export function makeExperimentConclusionRepo(db: Db, d1: D1Database) {
  return {
    getByActorKey(scope: TenantScope, concludedBy: string, idempotencyKey: string) {
      assertMintedScope(scope);
      return db
        .select()
        .from(experimentConclusions)
        .where(
          and(
            eq(experimentConclusions.appId, scope.appId),
            eq(experimentConclusions.concludedBy, concludedBy),
            eq(experimentConclusions.idempotencyKey, idempotencyKey),
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null);
    },

    get(scope: EnvScope, experimentId: string, runId: string, conclusionId: string) {
      assertMintedScope(scope);
      return db
        .select()
        .from(experimentConclusions)
        .where(
          and(
            eq(experimentConclusions.appId, scope.appId),
            eq(experimentConclusions.environmentId, scope.environmentId),
            eq(experimentConclusions.experimentId, experimentId),
            eq(experimentConclusions.runId, runId),
            eq(experimentConclusions.id, conclusionId),
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null);
    },

    listApprovalLinks(scope: TenantScope, conclusionId: string) {
      assertMintedScope(scope);
      return db
        .select()
        .from(conclusionApprovalRequests)
        .where(
          and(
            eq(conclusionApprovalRequests.appId, scope.appId),
            eq(conclusionApprovalRequests.conclusionId, conclusionId),
          ),
        )
        .orderBy(desc(conclusionApprovalRequests.ordinal));
    },

    async commit(scope: EnvScope, input: CommitConclusionInput) {
      assertMintedScope(scope);
      const statements = conclusionStatements(d1, scope, input);
      try {
        const results = await d1.batch(statements);
        return { ok: true as const, results };
      } catch (cause) {
        const replay = await this.getByActorKey(
          scope,
          input.conclusion.concludedBy,
          input.conclusion.idempotencyKey,
        );
        if (replay) return { ok: false as const, reason: "idempotency_race" as const, replay };
        throw cause;
      }
    },

    async createReplacement(scope: TenantScope, input: CreateReplacementPromotionInput) {
      assertMintedScope(scope);
      const results = await d1.batch(replacementStatements(d1, scope.appId, input));
      return (results[2]?.results ?? []).length === 1;
    },
  };
}
