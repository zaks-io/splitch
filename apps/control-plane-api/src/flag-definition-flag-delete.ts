import type { FlagCodeRemovalClaim, PolicyChangeType } from "@splitch/contracts";
import type { Repository } from "@splitch/db";
import type { HandlerArgs } from "@splitch/worker-runtime";
import { makeOtherApprovalApplication } from "./approval-application";
import { createApproval, replayApprovalIfExists } from "./approval-service";
import {
  configuredFlagEnvironments,
  environmentPolicyContexts,
  requiresReview,
} from "./approval-target";
import {
  captureFlagConfigPurgeTargets,
  deleteFlagD1Cascade,
  purgeFlagConfigsKvForKey,
} from "./flag-config-lifecycle";
import {
  codeRemovalRecordFromBody,
  recordFlagDeletionCodeRemoval,
} from "./flag-deletion-code-removal";
import { resourceNotEmpty, runningExperimentError } from "./flag-definition-errors";
import { experimentReferencingFlag } from "./flag-definition-guards";
import {
  type FlagDefinitionDeps,
  type LoadedFlag,
  loadWritableFlag,
} from "./flag-definition-handler-utils";

/**
 * Deleting a Flag destroys every Environment's Configuration, targeting rules,
 * and the whole Variant catalog, and it frees the Flag key for immediate reuse.
 * While it was ungated, `DELETE /flags/:flagId` followed by `POST /flags` with
 * the same key landed an attacker-chosen Variant value in a `confirm`
 * Environment's served snapshot with zero Reviews — the Variant-level
 * laundering chain moved up one level. It is therefore gated on
 * `variant_availability`, exactly as `flag_variants_delete` is.
 */
export async function deleteFlag(
  deps: FlagDefinitionDeps,
  args: HandlerArgs<unknown>,
): Promise<Response> {
  const loaded = await loadWritableFlag(deps, args);
  if (!loaded.ok) return loaded.response;

  const body = optionalDeleteBody(args.input);
  const codeRemoval = codeRemovalRecordFromBody(body);
  // proposalInput fingerprints the claim for idempotency; proposed carries it
  // for Review apply (ApprovalRequest has no separate proposalInput on the wire).
  const proposalInput = { flagId: loaded.value.flag.id, codeRemoval };
  const proposed = { codeRemoval };
  // Idempotency key is the header the registrar already requires for this route.
  const idempotencyKey = args.request.headers.get("idempotency-key") ?? "";
  const replay = await replayApprovalIfExists(
    { ...deps, applyOther: makeOtherApprovalApplication(deps) },
    {
      appId: loaded.value.appId,
      operation: "flags_delete",
      target: { type: "flag", id: loaded.value.flag.id },
      proposalInput,
      principal: args.principal,
      idempotencyKey,
      inlineReview: false,
      requestId: args.requestId,
    },
    { ignoreMismatch: true },
  );
  if (replay) return replay.ok ? Response.json({ deleted: true }) : replay.response;

  const blocked = await flagDeleteBlocker(deps, loaded.value, args.requestId);
  if (blocked) return blocked;

  const contexts = await flagPolicyContexts(deps.repo, loaded.value.appId, loaded.value.flag.id, [
    "variant_availability",
  ]);
  if (requiresReview(contexts)) {
    const approval = await createApproval(
      { ...deps, applyOther: makeOtherApprovalApplication(deps) },
      {
        appId: loaded.value.appId,
        operation: "flags_delete",
        target: { type: "flag", id: loaded.value.flag.id },
        policyContexts: contexts,
        current: flagProjection(loaded.value),
        proposed,
        proposalInput,
        principal: args.principal,
        idempotencyKey,
        inlineReview: false,
        requestId: args.requestId,
      },
    );
    if (!approval.ok) return approval.response;
    return Response.json({ deleted: true });
  }

  const purgeTargets = await captureFlagConfigPurgeTargets(
    deps,
    loaded.value.appId,
    loaded.value.flag.id,
  );
  await deleteFlagD1Cascade(deps, loaded.value.appId, loaded.value.flag.id);
  await recordFlagDeletionCodeRemoval(
    deps.repo,
    loaded.value.appId,
    loaded.value.flag.id,
    codeRemoval,
  );
  await purgeFlagConfigsKvForKey(
    deps,
    loaded.value.appId,
    loaded.value.flag.id,
    loaded.value.flag.key,
    purgeTargets,
  );
  return Response.json({ deleted: true });
}

function optionalDeleteBody(input: unknown): { codeRemoval?: FlagCodeRemovalClaim } | undefined {
  const value = (input as { body?: unknown } | null)?.body;
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("control-plane-api: flags_delete body must be an object when present");
  }
  return value as { codeRemoval?: FlagCodeRemovalClaim };
}

/**
 * Every Environment that serves the Flag, at its own Policy level. A Flag-level
 * change is not scoped to one Environment, so the strictest Environment's
 * Policy is what decides whether a Review is required.
 */
async function flagPolicyContexts(
  repo: Repository,
  appId: string,
  flagId: string,
  changeTypes: readonly PolicyChangeType[],
) {
  if (changeTypes.length === 0) return [];
  const configured = await configuredFlagEnvironments(repo, appId, flagId);
  return configured.flatMap((environment) =>
    environmentPolicyContexts(environment.environmentId, environment.policy, changeTypes),
  );
}

function flagProjection(loaded: LoadedFlag): Record<string, unknown> {
  return {
    flagId: loaded.flag.id,
    key: loaded.flag.key,
    name: loaded.flag.name,
    version: loaded.flag.version,
  };
}

async function flagDeleteBlocker(
  deps: FlagDefinitionDeps,
  loaded: LoadedFlag,
  requestId: string,
): Promise<Response | null> {
  const envs = await deps.repo.identity.listEnvironments(loaded.scope);
  const reference = await experimentReferencingFlag(deps.repo, loaded.appId, loaded.flag.id, envs);
  if (!reference) return null;
  if (reference.status === "running") {
    return runningExperimentError(
      { experimentId: reference.experimentId, runId: reference.runId ?? "unknown" },
      "DELETE_FLAG",
      requestId,
    );
  }
  return resourceNotEmpty("flag", loaded.flag.id, "experiment", 1, "DELETE_FLAG", requestId);
}
