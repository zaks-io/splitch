/**
 * Worker-side refusal proofs: dangling Variant, unauthorized Promotion, and
 * stale Review. Each asserts the exact contract code AND that the target Flag
 * Configuration was not mutated, because a refusal that half-applied would be
 * worse than no refusal at all.
 */

import assert from "node:assert/strict";

import {
  getFlagConfig,
  promoteFlagConfig,
  requireRefused,
  reviewApprovalRequest,
} from "./control-plane.mjs";
import { assertTargetUnchanged } from "./diff-assertions.mjs";

function issueMessages(body) {
  return (body?.details?.issues ?? []).map((issue) => issue.message);
}

/**
 * Promoting Targeting Rules that serve a Variant the target Environment does not
 * make available is a dangling dependency. The Worker refuses before minting an
 * Approval Request, so a gated Environment never banks an unappliable proposal.
 */
export async function proveDanglingVariantRejected(deps, ctx) {
  const before = await getFlagConfig(deps, ctx.appId, ctx.prodEnvironmentId, ctx.flagId);
  const result = await promoteFlagConfig(deps, {
    appId: ctx.appId,
    targetEnvironmentId: ctx.prodEnvironmentId,
    flagId: ctx.flagId,
    fromEnvironmentId: ctx.devEnvironmentId,
    // `targeting` without `availability` is precisely the dangling case.
    select: { targeting: true },
    label: "dangling",
  });

  const body = requireRefused(result, "dangling Variant Promotion");
  assert.equal(body.code, "VARIANT_NOT_AVAILABLE", "dangling Promotion returned the wrong code");
  assert.ok(
    (body.details?.missingVariants ?? []).includes(ctx.danglingVariant),
    `dangling Promotion did not name the missing Variant: ${JSON.stringify(body.details)}`,
  );
  assert.equal(body.details?.recommendedAction, "ADD_VARIANT_TO_ENV");

  const after = await getFlagConfig(deps, ctx.appId, ctx.prodEnvironmentId, ctx.flagId);
  assertTargetUnchanged(before, after, "dangling Variant Promotion");
  return { code: body.code, missingVariants: body.details.missingVariants };
}

/**
 * Unauthorized Promotion, three ways. All three are containment proofs for the
 * Promotion source: a caller must not be able to name an Environment outside the
 * App, and must not be able to launder a no-op through source === target.
 */
export async function proveUnauthorizedPromotionRejected(deps, ctx) {
  const before = await getFlagConfig(deps, ctx.appId, ctx.prodEnvironmentId, ctx.flagId);
  const codes = {};

  const crossApp = requireRefused(
    await promoteFlagConfig(deps, {
      appId: ctx.appId,
      targetEnvironmentId: ctx.prodEnvironmentId,
      flagId: ctx.flagId,
      fromEnvironmentId: ctx.otherAppEnvironmentId,
      select: { availability: [ctx.defaultVariant] },
      label: "cross-app-source",
    }),
    "cross-App source Environment Promotion",
  );
  assert.equal(crossApp.code, "VALIDATION_ERROR");
  assert.ok(
    issueMessages(crossApp).includes(
      `Environment ${ctx.otherAppEnvironmentId} does not exist in App ${ctx.appId}`,
    ),
    `cross-App source refusal did not name the Environment: ${JSON.stringify(crossApp.details)}`,
  );
  codes.crossAppSource = crossApp.code;

  const sameEnv = requireRefused(
    await promoteFlagConfig(deps, {
      appId: ctx.appId,
      targetEnvironmentId: ctx.prodEnvironmentId,
      flagId: ctx.flagId,
      fromEnvironmentId: ctx.prodEnvironmentId,
      select: { availability: [ctx.defaultVariant] },
      label: "same-env-source",
    }),
    "source === target Promotion",
  );
  assert.equal(sameEnv.code, "VALIDATION_ERROR");
  assert.ok(
    issueMessages(sameEnv).includes(
      `source Environment ${ctx.prodEnvironmentId} must differ from the target Environment`,
    ),
    `source === target refusal message drifted: ${JSON.stringify(sameEnv.details)}`,
  );
  codes.sameEnvironmentSource = sameEnv.code;

  const crossAppTarget = requireRefused(
    await promoteFlagConfig(deps, {
      appId: ctx.appId,
      targetEnvironmentId: ctx.otherAppEnvironmentId,
      flagId: ctx.flagId,
      fromEnvironmentId: ctx.devEnvironmentId,
      select: { availability: [ctx.defaultVariant] },
      label: "cross-app-target",
    }),
    "cross-App target Environment Promotion",
  );
  // Deliberately excludes VALIDATION_ERROR: this leg proves TARGET containment,
  // and a VALIDATION_ERROR here would mean the request died on source validation
  // before the target was ever checked, leaving the guard unproven.
  assert.ok(
    ["FORBIDDEN", "INSUFFICIENT_SCOPES", "FLAG_NOT_FOUND"].includes(crossAppTarget.code),
    `cross-App target refusal returned an unexpected code: ${crossAppTarget.code}`,
  );
  codes.crossAppTarget = crossAppTarget.code;

  const after = await getFlagConfig(deps, ctx.appId, ctx.prodEnvironmentId, ctx.flagId);
  assertTargetUnchanged(before, after, "unauthorized Promotion");
  return codes;
}

/**
 * A pending Approval Request pins the target version it was proposed against.
 * Applying a different change first must make the older proposal stale rather
 * than silently overwriting the newer state.
 */
export async function proveStaleReviewRejected(deps, ctx) {
  const pending = requireRefused(
    await promoteFlagConfig(deps, {
      appId: ctx.appId,
      targetEnvironmentId: ctx.prodEnvironmentId,
      flagId: ctx.flagId,
      fromEnvironmentId: ctx.devEnvironmentId,
      select: { availability: [ctx.defaultVariant, ctx.launchVariant], targeting: true },
      label: "stale-proposal",
    }),
    "gated Promotion without inline review",
  );
  assert.equal(pending.code, "APPROVAL_REVIEW_REQUIRED", "gated Promotion was not gated");
  const staleId = pending.details?.approvalRequestId;
  assert.ok(staleId, "gated Promotion omitted details.approvalRequestId");

  // Land an intervening change so the pinned target version moves on.
  const intervening = await promoteFlagConfig(deps, {
    appId: ctx.appId,
    targetEnvironmentId: ctx.prodEnvironmentId,
    flagId: ctx.flagId,
    fromEnvironmentId: ctx.devEnvironmentId,
    select: { availability: [ctx.defaultVariant, ctx.launchVariant] },
    review: { action: "approve_and_apply" },
    label: "stale-intervening",
  });
  assert.ok(intervening.ok, `intervening Promotion failed: ${JSON.stringify(intervening.body)}`);

  // Baseline taken AFTER the intervening change: the stale Review must not move
  // the target off the state the intervening Promotion legitimately left it in.
  const before = await getFlagConfig(deps, ctx.appId, ctx.prodEnvironmentId, ctx.flagId);

  const staleReview = requireRefused(
    await reviewApprovalRequest(deps, ctx.appId, staleId, "approve_and_apply", "stale"),
    "stale Approval Request Review",
  );
  assert.equal(staleReview.code, "APPROVAL_REQUEST_STALE", "stale Review returned the wrong code");
  assert.equal(staleReview.details?.recommendedAction, "REFRESH_AND_REPROPOSE");
  assert.notEqual(
    staleReview.details?.currentTargetVersion,
    staleReview.details?.targetVersion,
    "stale Review reported an unchanged target version",
  );

  const after = await getFlagConfig(deps, ctx.appId, ctx.prodEnvironmentId, ctx.flagId);
  assertTargetUnchanged(before, after, "stale Approval Request Review");
  return { approvalRequestId: staleId, code: staleReview.code };
}
