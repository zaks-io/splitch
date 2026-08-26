import { envScope, type Repository } from "@splitch/db";
import type { HandlerArgs } from "@splitch/worker-runtime";
import { requireAppAdmin } from "./app-authz";
import { canonicalHash } from "./approval-canonical";
import { createApproval, replayApprovalIfExists } from "./approval-service";
import { environmentPolicyContexts, requiresReview } from "./approval-target";
import type { ConfigStoreWriter } from "./config-store";
import type { ConfigStoreAccess } from "./config-store-do";
import { configStoreUnavailable } from "./experiment-errors";
import { flagConfigNotFound } from "./flag-config-errors";
import {
  actorOf,
  type PromotionSelect,
  renderFlagConfigReadFailure,
  renderPromotionResult,
} from "./flag-config-handler-render";
import { promotionGates, readEnvironmentPolicy } from "./flag-config-policy";
import { pathParam } from "./handler-input";
import { validatePromotionSource } from "./promotion-source-validation";

/**
 * Promotion is the one Flag Configuration write with two Environments in play:
 * the source it copies from and the target whose Policy decides whether the copy
 * needs a Review. Keeping it beside the single-Environment handlers made
 * `handlers.ts` the file every Flag route change had to edit.
 */

interface PromotionHandlerDeps {
  repo: Repository;
  configStore?: ConfigStoreAccess;
  nowIso?: () => string;
}

export function makePromotionHandlers(deps: PromotionHandlerDeps) {
  return {
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: source/target policy and Approval application stay explicit at the route boundary
    async promoteFlagConfig({
      input,
      principal,
      requestId,
    }: HandlerArgs<unknown>): Promise<Response> {
      if (!deps.configStore) return configStoreUnavailable(requestId);

      const appId = pathParam(input, "appId");
      const adminError = await requireAppAdmin(deps, appId, principal, requestId);
      if (adminError) return adminError;

      const source = await validatePromotionSource(deps.repo, input, appId, requestId);
      if (!source.ok) return source.response;
      const { body, flagId, fromEnvironmentId, targetEnvironmentId } = source;
      const configRow = await deps.repo.flags.getFlagConfig(
        envScope(appId, targetEnvironmentId),
        flagId,
      );
      if (!configRow) return flagConfigNotFound(requestId);
      const proposalInput = {
        fromEnvironmentId,
        select: body.select as PromotionSelect,
      };
      const replay = await replayApprovalIfExists(
        { ...deps, configStore: deps.configStore },
        {
          appId,
          operation: "flags_promote",
          target: { type: "flag_configuration", id: configRow.id },
          proposalInput,
          principal,
          idempotencyKey: body.idempotency_key as string,
          inlineReview: body.review !== undefined,
          requestId,
        },
        { ignoreMismatch: true },
      );
      if (replay) {
        if (!replay.ok) return replay.response;
        const applied = await deps.configStore
          .writerFor(appId, targetEnvironmentId)
          .readFlagConfig({ appId, environmentId: targetEnvironmentId, flagId });
        if (!applied.ok) return renderFlagConfigReadFailure(applied, requestId);
        return Response.json({
          ...applied.config,
          diff: {
            before: replay.approvalRequest.diff.current,
            after: replay.approvalRequest.diff.proposed,
          },
          approvalRequest: replay.approvalRequest,
        });
      }
      const policy = await readEnvironmentPolicy(deps.repo, appId, targetEnvironmentId);
      if (!policy) return flagConfigNotFound(requestId);

      const sourceConfig = await deps.repo.flags.getFlagConfig(
        envScope(appId, fromEnvironmentId),
        flagId,
      );
      if (!sourceConfig) return flagConfigNotFound(requestId);

      const gates = promotionGates(body.select as PromotionSelect, sourceConfig.enabled);
      const mutationInput: Parameters<ConfigStoreWriter["promoteFlagConfig"]>[0] = {
        actor: actorOf(principal),
        appId,
        targetEnvironmentId,
        flagId,
        fromEnvironmentId,
        select: body.select as PromotionSelect,
      };
      const contexts = environmentPolicyContexts(targetEnvironmentId, policy, gates);
      if (requiresReview(contexts)) {
        if (mutationInput.select.rollout) {
          mutationInput.approvalRolloutSalt = (
            await canonicalHash({
              operation: "flags_promote",
              appId,
              targetEnvironmentId,
              flagId,
              fromEnvironmentId,
              idempotencyKey: body.idempotency_key,
            })
          ).slice("sha256:".length, "sha256:".length + 16);
        }
        const writer = deps.configStore.writerFor(appId, targetEnvironmentId);
        const [current, preview] = await Promise.all([
          writer.readFlagConfig({
            appId,
            environmentId: targetEnvironmentId,
            flagId,
          }),
          writer.previewPromotion(mutationInput),
        ]);
        if (!current.ok) return renderFlagConfigReadFailure(current, requestId);
        if (!preview.ok) {
          return renderPromotionResult(preview, flagId, targetEnvironmentId, requestId, null);
        }
        const approval = await createApproval(
          { ...deps, configStore: deps.configStore },
          {
            appId,
            operation: "flags_promote",
            target: { type: "flag_configuration", id: configRow.id },
            policyContexts: contexts,
            current: current.config as unknown as Record<string, unknown>,
            proposed: preview.config as unknown as Record<string, unknown>,
            proposalInput,
            principal,
            idempotencyKey: body.idempotency_key as string,
            inlineReview: body.review !== undefined,
            requestId,
          },
        );
        if (!approval.ok) return approval.response;
        const applied = await writer.readFlagConfig({
          appId,
          environmentId: targetEnvironmentId,
          flagId,
        });
        if (!applied.ok) return renderFlagConfigReadFailure(applied, requestId);
        const approvalDiff = approval.approvalRequest.diff;
        return Response.json({
          ...applied.config,
          diff: {
            before: approvalDiff.current,
            after: approvalDiff.proposed,
          },
          approvalRequest: approval.approvalRequest,
        });
      }

      const result = await deps.configStore
        .writerFor(appId, targetEnvironmentId)
        .promoteFlagConfig(mutationInput);
      return renderPromotionResult(result, flagId, targetEnvironmentId, requestId, null);
    },
  };
}
