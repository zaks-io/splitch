/**
 * In-memory Control Plane test double for the safe-delivery journey. It models
 * the promote/approval contract closely enough to drive every proof: `dev` is an
 * `allow` Environment, `prod` is `confirm` on every change type, and
 * kill-switch-off is never gated.
 */

export const APP = "app-1";
export const DEV = "env-dev";
export const PROD = "env-prod";
export const OTHER = "env-other-app";
export const DEV_KEY = "pk-dev";
export const PROD_KEY = "pk-prod";

export function fakeControlPlane(overrides = {}) {
  const flags = new Map();
  const configs = new Map();
  const approvals = new Map();
  let nextApproval = 0;
  const key = (env, flagId) => `${env}:${flagId}`;
  const clone = (value) => JSON.parse(JSON.stringify(value));

  const json = (body, status = 200) => Response.json(body, { status });
  const error = (code, message, details = {}) =>
    json({ code, message, details }, code === "VALIDATION_ERROR" ? 400 : 409);

  function proposedFrom(select, source, target) {
    const next = clone(target);
    if (select.availability !== undefined) next.availableVariantNames = [...select.availability];
    if (select.targeting) next.targetingRules = clone(source.targetingRules);
    if (select.rollout) next.rollout = clone(source.rollout);
    if (select.enabled) next.enabled = source.enabled;
    return next;
  }

  function danglingVariants(proposed, flag) {
    const available = new Set(proposed.availableVariantNames);
    return proposed.targetingRules
      .map((rule) => flag.variants.find((variant) => variant.id === rule.variantId)?.name)
      .filter((name) => name && !available.has(name));
  }

  function apply(env, flagId, proposed) {
    const current = configs.get(key(env, flagId));
    const next = { ...proposed, version: current.version + 1 };
    configs.set(key(env, flagId), next);
    return clone(next);
  }

  const handlers = {
    createFlag(appId, body) {
      const id = `flag-${flags.size + 1}`;
      const flag = {
        id,
        key: body.key,
        variants: body.variants.map((variant, index) => ({ ...variant, id: `${id}-v${index}` })),
      };
      flags.set(id, flag);
      for (const env of [DEV, PROD]) {
        configs.set(key(env, id), {
          flagId: id,
          environmentId: env,
          version: 1,
          enabled: false,
          availableVariantNames: ["control"],
          targetingRules: [],
          rollout: null,
          experiment: null,
        });
      }
      return json(flag);
    },

    patchConfig(env, flagId, body) {
      const current = configs.get(key(env, flagId));
      if (!current) return error("FLAG_NOT_FOUND", "flag configuration not found");
      // enabled:false is the kill switch and is NEVER gated, in any Environment.
      const gated =
        env === PROD &&
        (body.enabled === true ||
          body.availableVariantNames !== undefined ||
          body.rollout !== undefined);
      const proposed = { ...current };
      if (body.enabled !== undefined) proposed.enabled = body.enabled;
      if (body.availableVariantNames)
        proposed.availableVariantNames = [...body.availableVariantNames];
      if (body.rollout !== undefined) proposed.rollout = body.rollout;
      if (gated && !body.review) {
        return error("APPROVAL_REVIEW_REQUIRED", "pending", { approvalRequestId: "ar-patch" });
      }
      const applied = apply(env, flagId, proposed);
      const isKillSwitch = env === PROD && body.enabled === false;
      return json({
        config: applied,
        approvalRequest: isKillSwitch ? (overrides.killSwitchApproval ?? null) : null,
      });
    },

    replaceRules(env, flagId, body) {
      const current = configs.get(key(env, flagId));
      const applied = apply(env, flagId, {
        ...current,
        targetingRules: clone(body.targetingRules),
      });
      return json({ config: applied, approvalRequest: null });
    },

    promote(appId, targetEnv, flagId, body) {
      if (![DEV, PROD].includes(targetEnv)) return error("FLAG_NOT_FOUND", "flag not found");
      if (![DEV, PROD].includes(body.fromEnvironmentId)) {
        return error("VALIDATION_ERROR", "promotion source Environment is invalid", {
          issues: [
            {
              path: ["fromEnvironmentId"],
              message: `Environment ${body.fromEnvironmentId} does not exist in App ${appId}`,
            },
          ],
        });
      }
      if (body.fromEnvironmentId === targetEnv) {
        return error("VALIDATION_ERROR", "promotion source Environment is invalid", {
          issues: [
            {
              path: ["fromEnvironmentId"],
              message: `source Environment ${targetEnv} must differ from the target Environment`,
            },
          ],
        });
      }
      const source = configs.get(key(body.fromEnvironmentId, flagId));
      const target = configs.get(key(targetEnv, flagId));
      const proposed = proposedFrom(body.select, source, target);
      const missing = danglingVariants(proposed, flags.get(flagId));
      if (missing.length > 0) {
        return error("VARIANT_NOT_AVAILABLE", "requested variants are not available", {
          flagId,
          environmentId: targetEnv,
          missingVariants: missing,
          recommendedAction: "ADD_VARIANT_TO_ENV",
        });
      }
      const gated = targetEnv === PROD && Object.keys(body.select).length > 0;
      if (gated && !body.review) {
        const id = `ar-${(nextApproval += 1)}`;
        approvals.set(id, {
          id,
          status: "pending",
          targetVersion: target.version,
          flagId,
          environmentId: targetEnv,
          select: body.select,
          fromEnvironmentId: body.fromEnvironmentId,
          diff: { current: clone(target), proposed: clone(proposed) },
        });
        return error("APPROVAL_REVIEW_REQUIRED", "Approval Request is pending Review", {
          approvalRequestId: id,
        });
      }
      const before = clone(target);
      const applied = apply(targetEnv, flagId, proposed);
      const id = `ar-${(nextApproval += 1)}`;
      const approval = {
        id,
        status: "applied",
        targetVersion: before.version,
        diff: { current: before, proposed: clone(applied) },
      };
      approvals.set(id, approval);
      return json({
        config: applied,
        diff: { before, after: clone(applied) },
        approvalRequest: approval,
      });
    },

    review(appId, approvalId) {
      const approval = approvals.get(approvalId);
      if (!approval) return error("APPROVAL_REQUEST_NOT_FOUND", "not found");
      const current = configs.get(key(approval.environmentId, approval.flagId));
      if (current.version !== approval.targetVersion) {
        return error("APPROVAL_REQUEST_STALE", "Approval Request target changed before Review", {
          approvalRequestId: approvalId,
          targetVersion: `sha256:${approval.targetVersion}`,
          currentTargetVersion: `sha256:${current.version}`,
          recommendedAction: "REFRESH_AND_REPROPOSE",
        });
      }
      const source = configs.get(key(approval.fromEnvironmentId, approval.flagId));
      const applied = apply(
        approval.environmentId,
        approval.flagId,
        proposedFrom(approval.select, source, current),
      );
      approval.status = "applied";
      approval.diff.proposed = clone(applied);
      return json(approval);
    },

    verify(clientKey, body) {
      const env = clientKey === PROD_KEY ? PROD : DEV;
      const flag = [...flags.values()].find((candidate) => candidate.key === body.flagKey);
      const config = configs.get(key(env, flag.id));
      const defaultVariant = flag.variants.find((variant) => variant.isDefault).name;
      if (!config.enabled) return json({ variant: defaultVariant, reason: "DISABLED" });
      const match = config.targetingRules.find((rule) =>
        rule.conditions.every(
          (condition) => body.attributes[condition.attribute] === condition.value,
        ),
      );
      if (!match) return json({ variant: defaultVariant, reason: "DEFAULT" });
      const name = flag.variants.find((variant) => variant.id === match.variantId).name;
      if (!config.availableVariantNames.includes(name)) {
        return json({ variant: defaultVariant, reason: "DEFAULT" });
      }
      return json({ variant: name, reason: "TARGETING_MATCH" });
    },
  };

  return async function fetchImpl(url, init) {
    const { pathname } = new URL(url);
    const body = init.body ? JSON.parse(init.body) : undefined;
    const method = init.method ?? "GET";

    if (pathname === "/api/sdk/verify") {
      return handlers.verify(init.headers.authorization.replace("Bearer ", ""), body);
    }
    let match = pathname.match(
      /^\/apps\/([^/]+)\/envs\/([^/]+)\/flags\/([^/]+)\/(config|targeting-rules|promote)$/,
    );
    if (match) {
      const [, , env, flagId, leaf] = match;
      if (leaf === "config" && method === "GET") {
        const config = configs.get(key(env, flagId));
        return config ? json(clone(config)) : error("FLAG_NOT_FOUND", "not found");
      }
      if (leaf === "config") return handlers.patchConfig(env, flagId, body);
      if (leaf === "targeting-rules") return handlers.replaceRules(env, flagId, body);
      return handlers.promote(APP, env, flagId, body);
    }
    match = pathname.match(/^\/apps\/([^/]+)\/approval-requests(?:\/([^/]+)(?:\/(reviews))?)?$/);
    if (match) {
      const [, appId, approvalId, reviews] = match;
      if (reviews) return handlers.review(appId, approvalId);
      if (approvalId) return json(approvals.get(approvalId));
      const status = new URL(url).searchParams.get("status");
      return json({
        items: [...approvals.values()].filter((ar) => !status || ar.status === status),
      });
    }
    match = pathname.match(/^\/apps\/([^/]+)\/flags(?:\/([^/]+))?$/);
    if (match) {
      const [, appId, flagId] = match;
      if (method === "POST") return handlers.createFlag(appId, body);
      if (method === "DELETE") {
        flags.delete(flagId);
        return json({ deleted: true });
      }
      return json({ items: [...flags.values(), { id: "stable", key: "shared-preview-smoke" }] });
    }
    throw new Error(`unexpected request: ${method} ${pathname}`);
  };
}
