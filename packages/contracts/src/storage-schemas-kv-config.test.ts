import { describe, expect, it } from "vitest";
import {
  CredentialCacheKVSchema,
  CredentialCacheKVSchemaV1,
  ExperimentConfigKVSchema,
  FlagConfigKVSchema,
  LiveRunKVSchema,
  RunConfigKVSchema,
} from "./storage-schemas-kv";

const validVariants = [
  { id: "var_1", name: "control", value: false },
  { id: "var_2", name: "treatment", value: "on" },
];

const validTargetingRule = {
  id: "tr_1",
  flagId: "flag_1",
  priority: 0,
  conditions: [{ attribute: "plan", operator: "eq" as const, value: "enterprise" }],
  variantId: "var_1",
};

const validFlagConfig = {
  id: "flag_1",
  key: "checkout-redesign",
  environmentId: "env_prod",
  experimentId: "exp_1",
  enabled: true,
  defaultVariantId: "var_1",
  variants: validVariants,
  availableVariantNames: ["control", "treatment"],
  targetingRules: [validTargetingRule],
  rollout: null,
  updatedAt: "2024-01-01T00:00:00Z",
};

describe("FlagConfigKVSchema", () => {
  it("parses a valid blob and composes the Variant/TargetingRule leaves", () => {
    const cfg = FlagConfigKVSchema.parse(validFlagConfig);
    expect(cfg.experimentId).toBe("exp_1");
    expect(cfg.variants).toHaveLength(2);
    expect(cfg.targetingRules).toHaveLength(1);
  });

  it("accepts experimentId present-with-null (no Experiment controls the Flag)", () => {
    const cfg = FlagConfigKVSchema.parse({ ...validFlagConfig, experimentId: null });
    expect(cfg.experimentId).toBeNull();
  });

  it("REJECTS an OMITTED experimentId — nullable-not-absent, never ambiguous", () => {
    const { experimentId: _omitted, ...withoutExperimentId } = validFlagConfig;
    expect(FlagConfigKVSchema.safeParse(withoutExperimentId).success).toBe(false);
  });

  it("rejects a partial blob missing a required field (fail-loud, no partial object)", () => {
    const { enabled: _enabled, ...partial } = validFlagConfig;
    expect(FlagConfigKVSchema.safeParse(partial).success).toBe(false);
  });

  it("rejects an unknown extra key (strict storage shape)", () => {
    expect(FlagConfigKVSchema.safeParse({ ...validFlagConfig, leaked: "x" }).success).toBe(false);
  });

  it("rejects a malformed nested Variant leaf", () => {
    const bad = { ...validFlagConfig, variants: [{ id: "var_1" }] };
    expect(FlagConfigKVSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects an authoring Segment reference in the resolved KV projection", () => {
    expect(
      FlagConfigKVSchema.safeParse({
        ...validFlagConfig,
        targetingRules: [{ ...validTargetingRule, segmentId: "segment_enterprise" }],
      }).success,
    ).toBe(false);
  });
});

const validRunConfig = {
  id: "run_1",
  experimentId: "exp_1",
  salt: "run-salt-abc",
  allocation: { control: 50, treatment: 50 },
  variantSet: validVariants,
  targetingRules: [validTargetingRule],
  configHash: "sha256:deadbeef",
  startedAt: "2024-01-01T00:00:00Z",
};

describe("RunConfigKVSchema", () => {
  it("parses a valid blob with name-keyed allocation", () => {
    const cfg = RunConfigKVSchema.parse(validRunConfig);
    expect(cfg.allocation).toEqual({ control: 50, treatment: 50 });
    expect(cfg.variantSet).toHaveLength(2);
  });

  it("accepts an empty targetingRules snapshot (all Entities eligible)", () => {
    const cfg = RunConfigKVSchema.parse({ ...validRunConfig, targetingRules: [] });
    expect(cfg.targetingRules).toHaveLength(0);
  });

  it("does NOT carry targetingKey (it lives on ExperimentConfigKV)", () => {
    const bad = { ...validRunConfig, targetingKey: "userId" };
    expect(RunConfigKVSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a partial blob missing configHash (integrity anchor)", () => {
    const { configHash: _configHash, ...partial } = validRunConfig;
    expect(RunConfigKVSchema.safeParse(partial).success).toBe(false);
  });
});

const validExperimentConfig = {
  id: "exp_1",
  environmentId: "env_prod",
  flagId: "flag_1",
  targetingKey: "userId",
  targetingKeyType: "user",
  status: "running" as const,
  liveRunId: "run_1",
};

describe("ExperimentConfigKVSchema", () => {
  it("parses a valid blob", () => {
    const cfg = ExperimentConfigKVSchema.parse(validExperimentConfig);
    expect(cfg.targetingKey).toBe("userId");
    expect(cfg.status).toBe("running");
  });

  it("accepts liveRunId present-with-null (no Run live yet)", () => {
    const cfg = ExperimentConfigKVSchema.parse({ ...validExperimentConfig, liveRunId: null });
    expect(cfg.liveRunId).toBeNull();
  });

  it("rejects an OMITTED liveRunId (nullable-not-absent)", () => {
    const { liveRunId: _liveRunId, ...partial } = validExperimentConfig;
    expect(ExperimentConfigKVSchema.safeParse(partial).success).toBe(false);
  });

  it("rejects an OMITTED status (the edge needs the lifecycle state)", () => {
    const { status: _status, ...partial } = validExperimentConfig;
    expect(ExperimentConfigKVSchema.safeParse(partial).success).toBe(false);
  });

  it("rejects an unknown status value (reuses the ExperimentStatus enum)", () => {
    expect(
      ExperimentConfigKVSchema.safeParse({ ...validExperimentConfig, status: "paused" }).success,
    ).toBe(false);
  });
});

const validCredentialCache = {
  appId: "app_1",
  environmentId: "env_prod",
  credentialSchemaVersion: 2 as const,
  organizationId: "org_1",
  kind: "api_key" as const,
  scopes: ["data-plane:evaluate", "data-plane:write"],
  revoked: false,
  cachedAt: "2024-01-01T00:00:00Z",
};

describe("CredentialCacheKVSchema", () => {
  it("parses a valid api_key cache entry", () => {
    const c = CredentialCacheKVSchema.parse(validCredentialCache);
    expect(c.kind).toBe("api_key");
    expect(c.revoked).toBe(false);
  });

  it("parses a client_key cache entry", () => {
    const c = CredentialCacheKVSchema.parse({
      ...validCredentialCache,
      kind: "client_key",
      originAllowlist: ["https://app.example.test"],
      rateLimitRps: 25,
    });
    expect(c.kind).toBe("client_key");
    expect(c.originAllowlist).toEqual(["https://app.example.test"]);
    expect(c.rateLimitRps).toBe(25);
  });

  it("rejects an unknown credential kind", () => {
    expect(
      CredentialCacheKVSchema.safeParse({ ...validCredentialCache, kind: "oauth" }).success,
    ).toBe(false);
  });

  it("rejects a partial blob missing revoked (a revoke tombstone must be explicit)", () => {
    const { revoked: _revoked, ...partial } = validCredentialCache;
    expect(CredentialCacheKVSchema.safeParse(partial).success).toBe(false);
  });

  it("rejects an active cache entry without tenant scope", () => {
    expect(
      CredentialCacheKVSchema.safeParse({ ...validCredentialCache, organizationId: null }).success,
    ).toBe(false);
  });

  it("allows an unscoped revoke tombstone because it cannot authorize evaluation", () => {
    expect(
      CredentialCacheKVSchema.safeParse({
        ...validCredentialCache,
        organizationId: null,
        revoked: true,
      }).success,
    ).toBe(true);
  });

  it("does not accept a schema-v1 payload as a new write", () => {
    const { credentialSchemaVersion: _version, ...legacy } = validCredentialCache;
    expect(CredentialCacheKVSchema.safeParse(legacy).success).toBe(false);
  });

  it("keeps schema-v1 payload compatibility explicit at the reader schema", () => {
    const {
      credentialSchemaVersion: _version,
      organizationId: _organizationId,
      ...legacy
    } = validCredentialCache;
    expect(CredentialCacheKVSchemaV1.safeParse(legacy).success).toBe(true);
  });
});

describe("LiveRunKVSchema", () => {
  it("parses the minimal live-run pointer", () => {
    expect(LiveRunKVSchema.parse({ runId: "run_1" }).runId).toBe("run_1");
  });

  it("rejects an extra key (strict pointer blob)", () => {
    expect(LiveRunKVSchema.safeParse({ runId: "run_1", environmentId: "env_prod" }).success).toBe(
      false,
    );
  });

  it("rejects a missing runId", () => {
    expect(LiveRunKVSchema.safeParse({}).success).toBe(false);
  });
});
