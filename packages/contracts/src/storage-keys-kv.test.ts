import { describe, expect, it } from "vitest";
import {
  apiKeyCacheKey,
  assignmentKey,
  clientKeyCacheKey,
  flagConfigKey,
  liveRunKey,
  runConfigKey,
} from "./storage-keys-kv.js";

describe("config key-pattern constructors (per-Environment, ADR-0027)", () => {
  it("flagConfigKey produces app:{appId}:{environmentId}:flag:{flagKey}", () => {
    expect(flagConfigKey("app_1", "env_prod", "checkout-redesign")).toBe(
      "app:app_1:env_prod:flag:checkout-redesign",
    );
  });

  it("runConfigKey produces app:{appId}:{environmentId}:run:{runId}", () => {
    expect(runConfigKey("app_1", "env_prod", "run_10")).toBe("app:app_1:env_prod:run:run_10");
  });

  it("liveRunKey produces app:{appId}:{environmentId}:liveRun", () => {
    expect(liveRunKey("app_1", "env_prod")).toBe("app:app_1:env_prod:liveRun");
  });
});

describe("credential cache key-pattern constructors", () => {
  it("clientKeyCacheKey produces ck:{keyMaterialHash}", () => {
    expect(clientKeyCacheKey("abc123")).toBe("ck:abc123");
  });

  it("apiKeyCacheKey produces ak:{keyHash}", () => {
    expect(apiKeyCacheKey("def456")).toBe("ak:def456");
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
