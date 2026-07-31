import type { TargetingRule } from "@splitch/contracts";
import { envScope, type Repository } from "@splitch/db";
import type { HandlerArgs } from "@splitch/worker-runtime";
import { renderError } from "@splitch/worker-runtime";
import { requireAppAdmin } from "./app-authz";
import { canonicalHash } from "./approval-canonical";
import { createApproval, replayApprovalIfExists } from "./approval-service";
import { environmentPolicyContexts, requiresReview } from "./approval-target";
import type { ConfigStoreWriter } from "./config-store";
import type { ConfigStoreAccess } from "./config-store-do";
import { configStoreUnavailable } from "./experiment-errors";
import { flagConfigNotFound } from "./flag-config-errors";
import {
  flagConfigPatchInput,
  flagConfigProposalInput,
  type PromotionSelect,
  renderFlagConfigWriteResult,
  renderPromotionResult,
} from "./flag-config-handler-render";
import { flagConfigPatchGates, promotionGates, readEnvironmentPolicy } from "./flag-config-policy";
import { flagConfigFreezeRefusal, targetingFreezeRefusal } from "./flag-config-run-freeze";
import { objectBody, pathParam } from "./handler-input";
import { type MemberProfileResolver, makeOrgHandlers } from "./org-handlers";

/**
 * Minimal-but-real control-plane handlers for the mounted routes. They run AFTER
 * the guard has resolved the Principal and enforced scopes + App co-scope, so by
 * the time a handler executes the caller is authorized for this App: the guard
 * already rejected a null/mismatched-App principal with FORBIDDEN before any
 * repository call (steps/scopes.ts). The handler reads through the @splitch/db
 * repository seam (the only D1 entry, ADR-0018), never a raw client.
 *
 * Domain breadth is intentionally incremental: Org/member handlers live in their
 * own module, while App and Flag Configuration handlers stay here.
 *
 * The registry erases the route's Zod generics to `unknown` at the registrar
 * boundary, so each handler re-reads the single path param it needs from the
 * already-validated input, failing loud if the expected shape is somehow absent
 * (it cannot be: parseInput validated it against the contract first).
 */

interface HandlerDeps {
  repo: Repository;
  configStore?: ConfigStoreAccess;
  memberProfileResolver?: MemberProfileResolver;
  nowIso?: () => string;
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: the returned handler registry keeps route ownership visible in one place
export function makeHandlers(deps: HandlerDeps) {
  return {
    ...makeOrgHandlers(deps),

    async getFlagConfig({ input, requestId }: HandlerArgs<unknown>): Promise<Response> {
      if (!deps.configStore) return configStoreUnavailable(requestId);

      const appId = pathParam(input, "appId");
      const environmentId = pathParam(input, "environmentId");
      const flagId = pathParam(input, "flagId");
      const result = await deps.configStore
        .writerFor(appId, environmentId)
        .readFlagConfig({ appId, environmentId, flagId });

      if (!result.ok) {
        return renderError(
          { code: "FLAG_NOT_FOUND", message: "flag configuration not found", details: {} },
          { requestId },
        );
      }
      return Response.json(result.config);
    },

    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: authorization, preview, Approval creation, and application are ordered fail-fast gates
    async updateFlagConfig({
      input,
      principal,
      requestId,
    }: HandlerArgs<unknown>): Promise<Response> {
      if (!deps.configStore) return configStoreUnavailable(requestId);

      const appId = pathParam(input, "appId");
      const environmentId = pathParam(input, "environmentId");
      const flagId = pathParam(input, "flagId");
      const adminError = await requireAppAdmin(deps, appId, principal, requestId);
      if (adminError) return adminError;

      const body = objectBody(input);
      const configRow = await deps.repo.flags.getFlagConfig(envScope(appId, environmentId), flagId);
      if (!configRow) return flagConfigNotFound(requestId);
      const replay = await replayApprovalIfExists(
        { ...deps, configStore: deps.configStore },
        {
          appId,
          operation: "flag_config_update",
          target: { type: "flag_configuration", id: configRow.id },
          proposalInput: flagConfigProposalInput(body),
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
          .writerFor(appId, environmentId)
          .readFlagConfig({ appId, environmentId, flagId });
        return applied.ok
          ? Response.json({
              config: applied.config,
              approvalRequest: replay.approvalRequest,
            })
          : flagConfigNotFound(requestId);
      }
      // Ahead of the Policy gate on purpose: a write a live Run forbids must never
      // become a pending Approval Request. Gating it first would manufacture a
      // proposal for a change that can never legitimately be applied, and leave it
      // sitting in the audit log for a reviewer to approve into a refusal.
      const target = { appId, environmentId, flagId };
      const frozen = await flagConfigFreezeRefusal(deps.repo, target, body, requestId);
      if (frozen) return frozen;

      const policy = await readEnvironmentPolicy(deps.repo, appId, environmentId);
      if (!policy) return flagConfigNotFound(requestId);

      const mutationInput = flagConfigPatchInput(appId, environmentId, flagId, body);
      const contexts = environmentPolicyContexts(environmentId, policy, flagConfigPatchGates(body));
      if (requiresReview(contexts)) {
        if (mutationInput.rollout && mutationInput.approvalRolloutSalt === undefined) {
          mutationInput.approvalRolloutSalt = (
            await canonicalHash({
              appId,
              environmentId,
              flagId,
              idempotencyKey: body.idempotency_key,
            })
          ).slice("sha256:".length, "sha256:".length + 16);
        }
        const current = await deps.configStore
          .writerFor(appId, environmentId)
          .readFlagConfig({ appId, environmentId, flagId });
        const preview = await deps.configStore
          .writerFor(appId, environmentId)
          .previewFlagConfig(mutationInput);
        if (!current.ok) return flagConfigNotFound(requestId);
        if (!preview.ok) {
          return renderFlagConfigWriteResult(preview, flagId, environmentId, requestId, null);
        }
        const approval = await createApproval(
          { ...deps, configStore: deps.configStore },
          {
            appId,
            operation: "flag_config_update",
            target: { type: "flag_configuration", id: configRow.id },
            policyContexts: contexts,
            current: current.config as unknown as Record<string, unknown>,
            proposed: preview.config as unknown as Record<string, unknown>,
            proposalInput: flagConfigProposalInput(body),
            principal,
            idempotencyKey: body.idempotency_key as string,
            inlineReview: body.review !== undefined,
            requestId,
          },
        );
        if (!approval.ok) return approval.response;
        const applied = await deps.configStore
          .writerFor(appId, environmentId)
          .readFlagConfig({ appId, environmentId, flagId });
        if (!applied.ok) return flagConfigNotFound(requestId);
        return Response.json({
          config: applied.config,
          approvalRequest: approval.approvalRequest,
        });
      }

      const result = await deps.configStore
        .writerFor(appId, environmentId)
        .writeFlagConfig(mutationInput);
      return renderFlagConfigWriteResult(result, flagId, environmentId, requestId, null);
    },

    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: authorization, preview, Approval creation, and application are ordered fail-fast gates
    async replaceTargetingRules({
      input,
      principal,
      requestId,
    }: HandlerArgs<unknown>): Promise<Response> {
      if (!deps.configStore) return configStoreUnavailable(requestId);

      const appId = pathParam(input, "appId");
      const environmentId = pathParam(input, "environmentId");
      const flagId = pathParam(input, "flagId");
      const adminError = await requireAppAdmin(deps, appId, principal, requestId);
      if (adminError) return adminError;

      const body = objectBody(input);
      const configRow = await deps.repo.flags.getFlagConfig(envScope(appId, environmentId), flagId);
      if (!configRow) return flagConfigNotFound(requestId);
      const replay = await replayApprovalIfExists(
        { ...deps, configStore: deps.configStore },
        {
          appId,
          operation: "flag_targeting_rules_replace",
          target: { type: "flag_configuration", id: configRow.id },
          proposalInput: { targetingRules: body.targetingRules },
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
          .writerFor(appId, environmentId)
          .readFlagConfig({ appId, environmentId, flagId });
        return applied.ok
          ? Response.json({
              config: applied.config,
              approvalRequest: replay.approvalRequest,
            })
          : flagConfigNotFound(requestId);
      }
      // Same ordering as the Configuration PATCH, and for the same reason: the Run
      // refusal outranks the Policy gate.
      const frozen = await targetingFreezeRefusal(
        deps.repo,
        { appId, environmentId, flagId },
        requestId,
      );
      if (frozen) return frozen;

      const policy = await readEnvironmentPolicy(deps.repo, appId, environmentId);
      if (!policy) return flagConfigNotFound(requestId);

      const mutationInput = {
        appId,
        environmentId,
        flagId,
        targetingRules: body.targetingRules as TargetingRule[],
      };
      const contexts = environmentPolicyContexts(environmentId, policy, [
        "targeting_rollout_value",
      ]);
      if (requiresReview(contexts)) {
        const writer = deps.configStore.writerFor(appId, environmentId);
        const [current, preview] = await Promise.all([
          writer.readFlagConfig({ appId, environmentId, flagId }),
          writer.previewTargetingRules(mutationInput),
        ]);
        if (!current.ok) return flagConfigNotFound(requestId);
        if (!preview.ok) {
          return renderFlagConfigWriteResult(preview, flagId, environmentId, requestId, null);
        }
        const approval = await createApproval(
          { ...deps, configStore: deps.configStore },
          {
            appId,
            operation: "flag_targeting_rules_replace",
            target: { type: "flag_configuration", id: configRow.id },
            policyContexts: contexts,
            current: current.config as unknown as Record<string, unknown>,
            proposed: preview.config as unknown as Record<string, unknown>,
            proposalInput: { targetingRules: mutationInput.targetingRules },
            principal,
            idempotencyKey: body.idempotency_key as string,
            inlineReview: body.review !== undefined,
            requestId,
          },
        );
        if (!approval.ok) return approval.response;
        const applied = await writer.readFlagConfig({ appId, environmentId, flagId });
        if (!applied.ok) return flagConfigNotFound(requestId);
        return Response.json({
          config: applied.config,
          approvalRequest: approval.approvalRequest,
        });
      }

      const result = await deps.configStore
        .writerFor(appId, environmentId)
        .replaceTargetingRules(mutationInput);
      return renderFlagConfigWriteResult(result, flagId, environmentId, requestId, null);
    },

    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: source/target policy and Approval application stay explicit at the route boundary
    async promoteFlagConfig({
      input,
      principal,
      requestId,
    }: HandlerArgs<unknown>): Promise<Response> {
      if (!deps.configStore) return configStoreUnavailable(requestId);

      const appId = pathParam(input, "appId");
      const targetEnvironmentId = pathParam(input, "targetEnvironmentId");
      const flagId = pathParam(input, "flagId");
      const adminError = await requireAppAdmin(deps, appId, principal, requestId);
      if (adminError) return adminError;

      const body = objectBody(input);
      const fromEnvironmentId = body.fromEnvironmentId as string;
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
        if (!applied.ok) return flagConfigNotFound(requestId);
        return Response.json({
          config: applied.config,
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
        if (!current.ok) return flagConfigNotFound(requestId);
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
        if (!applied.ok) return flagConfigNotFound(requestId);
        const approvalDiff = approval.approvalRequest.diff;
        return Response.json({
          config: applied.config,
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
