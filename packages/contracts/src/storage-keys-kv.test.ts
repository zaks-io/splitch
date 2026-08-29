import { describe, expect, it } from "vitest";
import {
  apiKeyCacheKey,
  appEntityIdentityKey,
  assignmentKey,
  clientKeyCacheKey,
  controlPlaneFlagConfigKey,
  credentialRevocationCacheKey,
  experimentConfigKey,
  flagConfigKey,
  liveRunKey,
  memberProfileCacheKey,
  runConfigKey,
  TERMINAL_CREDENTIAL_REVOCATION_MARKER,
} from "./storage-keys-kv";

describe("config key-pattern constructors (per-Environment, ADR-0027)", () => {
  it("flagConfigKey produces app:{appId}:{environmentId}:flag:{flagKey}", () => {
    expect(flagConfigKey("app_1", "env_prod", "checkout-redesign")).toBe(
      "app:app_1:env_prod:flag:checkout-redesign",
    );
  });

  it("controlPlaneFlagConfigKey produces an App and Environment scoped Flag id key", () => {
    expect(controlPlaneFlagConfigKey("app_1", "env_prod", "flag_1")).toBe(
      "app:app_1:env_prod:control-plane-flag-config:flag_1",
    );
  });

  it("runConfigKey produces app:{appId}:{environmentId}:run:{runId}", () => {
    expect(runConfigKey("app_1", "env_prod", "run_10")).toBe("app:app_1:env_prod:run:run_10");
  });

  it("liveRunKey produces live_run:{appId}:{environmentId}:{experimentId}", () => {
    expect(liveRunKey("app_1", "env_prod", "exp_5")).toBe("live_run:app_1:env_prod:exp_5");
  });

  it("experimentConfigKey produces app:{appId}:{environmentId}:experiment:{experimentId}", () => {
    expect(experimentConfigKey("app_1", "env_prod", "exp_5")).toBe(
      "app:app_1:env_prod:experiment:exp_5",
    );
  });
});

describe("credential cache key-pattern constructors", () => {
  it("clientKeyCacheKey produces ck:{keyMaterialHash}", () => {
    expect(clientKeyCacheKey("abc123")).toBe("ck:abc123");
  });

  it("apiKeyCacheKey produces ak:{keyHash}", () => {
    expect(apiKeyCacheKey("def456")).toBe("ak:def456");
  });

  it("credentialRevocationCacheKey isolates terminal revocation from the mutable entry", () => {
    expect(credentialRevocationCacheKey(clientKeyCacheKey("abc123"))).toBe("revoked:ck:abc123");
    expect(TERMINAL_CREDENTIAL_REVOCATION_MARKER).toBe("1");
  });
});

describe("member profile identity-cache key", () => {
  it("memberProfileCacheKey produces member-profile:{userId}", () => {
    expect(memberProfileCacheKey("user_01ABC")).toBe("member-profile:user_01ABC");
  });
});

describe("assignment key-pattern constructor (per-Entity, ADR-0008/0009)", () => {
  it("produces assignment:{appId}:{idType}:{targetingKeyHash}", () => {
    expect(assignmentKey("app_1", "user", "hash_xyz")).toBe("assignment:app_1:user:hash_xyz");
  });

  it("OMITS environmentId — experimentId implies the Environment", () => {
    const key = assignmentKey("app_1", "user", "hash_xyz");
    const segments = key.split(":");
    // assignment : appId : idType : targetingKeyHash  → exactly 4 segments
    expect(segments).toHaveLength(4);
    expect(segments).toEqual(["assignment", "app_1", "user", "hash_xyz"]);
  });

  it("does not embed a raw Targeting Key — only the supplied hash appears", () => {
    const key = assignmentKey("app_1", "user", "hash_of_user_42");
    expect(key.endsWith(":hash_of_user_42")).toBe(true);
  });
});

describe("App entity identity key", () => {
  it("produces app:{appId}:entity-identity", () => {
    expect(appEntityIdentityKey("app_1")).toBe("app:app_1:entity-identity");
  });
});
