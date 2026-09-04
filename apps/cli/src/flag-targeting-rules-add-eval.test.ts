import { writeFile } from "node:fs/promises";
import type { TargetingRule } from "@splitch/sdk/control-plane";
import { evaluatePath } from "@splitch/sdk/local-evaluation";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "./cli.js";
import { EXIT_OK } from "./exit-codes.js";
import { flagsListStub, scopeResolutionStubs } from "./scope-resolution-fixtures.js";
import { FakeCliTransport, flagConfigResponse, storedCredential } from "./test-fixtures.js";
import { cleanupTempHomes, makeTempHome } from "./test-helpers.js";

afterEach(async () => {
  await cleanupTempHomes();
});

const VARIANTS = [
  { id: "var_on", name: "on", value: true },
  { id: "var_off", name: "off", value: false },
];

function flagsGetStub() {
  return {
    match: (request: { method: string; url: string }) =>
      request.method === "GET" && new URL(request.url).pathname === "/apps/app_1/flags/flag_1",
    status: 200,
    body: {
      id: "flag_1",
      appId: "app_1",
      key: "flag-1",
      name: "Flag 1",
      schema: { type: "boolean" },
      variants: VARIANTS,
      defaultVariantId: "var_off",
      createdAt: "2026-07-03T00:00:00.000Z",
      updatedAt: "2026-07-03T00:00:00.000Z",
    },
  };
}

function addTransport() {
  return new FakeCliTransport([
    ...scopeResolutionStubs(),
    flagsListStub({ flags: [{ id: "flag_1", key: "flag-1", name: "Flag 1" }] }),
    flagsGetStub(),
    {
      match: (request: { method: string; url: string }) =>
        request.method === "GET" && request.url.includes("/flags/flag_1/config"),
      status: 200,
      body: { ...flagConfigResponse, targetingRules: [] },
    },
    {
      match: (request: { method: string; url: string }) =>
        request.method === "PUT" && request.url.includes("/targeting-rules"),
      status: 200,
      body: { ...flagConfigResponse, approvalRequest: null },
    },
  ]);
}

async function addRule(when: string): Promise<TargetingRule> {
  const transport = addTransport();
  const { credentialPath } = await makeTempHome();
  await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`);
  const code = await runCli(
    [
      "flag-targeting-rules",
      "add",
      "--json",
      "--app",
      "app_1",
      "--env",
      "env_1",
      "flag_1",
      "--when",
      when,
      "--serve",
      "on",
    ],
    { credentialPath, fetch: transport.fetch },
  );
  expect(code).toBe(EXIT_OK);
  const replace = transport.requests.find(
    (request) => request.method === "PUT" && request.url.includes("/targeting-rules"),
  );
  const body = replace?.body as { targetingRules?: TargetingRule[] } | undefined;
  const rule = body?.targetingRules?.[0];
  if (!rule) throw new Error("add did not write a Targeting Rule");
  return rule;
}

async function testEval(
  rule: TargetingRule,
  attributes: Record<string, string | number | boolean>,
) {
  return evaluatePath(
    {
      appId: "app_1",
      environmentId: "env_1",
      flagKey: "flag-1",
      evaluationContext: { targetingKey: "user-1", idType: "user", attributes },
    },
    {
      assignmentStore: {
        getAll: async () => new Map(),
        put: async () => ({ status: "stored" as const, assignment: { runId: "", variant: "" } }),
        putHashed: async () => ({
          status: "stored" as const,
          assignment: { runId: "", variant: "" },
        }),
      },
      provider: {
        getExperiment: async () => {
          throw new Error("flag-only evaluate must not load an Experiment");
        },
        getFlags: async () => [],
        getFlag: async () => ({
          flagKey: "flag-1",
          appId: "app_1",
          environmentId: "env_1",
          experimentId: null,
          enabled: true,
          defaultVariant: "off",
          variants: VARIANTS,
          availableVariantNames: ["on", "off"],
          targetingRules: [rule],
          rollout: null,
        }),
      },
    },
  );
}

describe("flag-targeting-rules add evaluation (SPL-405)", () => {
  it("matches a numeric-looking string context and defaults otherwise", async () => {
    const rule = await addRule("postalCode=001");
    expect(rule.conditions[0]).toEqual({
      attribute: "postalCode",
      operator: "eq",
      value: "001",
    });

    const matched = await testEval(rule, { postalCode: "001" });
    expect(matched.variant).toBe("on");
    expect(matched.reason).toMatchObject({ type: "rule_matched" });

    const numericLookalike = await testEval(rule, { postalCode: 1 });
    expect(numericLookalike.variant).toBe("off");
    expect(numericLookalike.reason).toEqual({ type: "no_match_default" });

    const absent = await testEval(rule, {});
    expect(absent.variant).toBe("off");
    expect(absent.reason).toEqual({ type: "no_match_default" });
  });

  it("matches a boolean-looking string context and not the boolean true", async () => {
    const rule = await addRule("label=true");
    expect(rule.conditions[0]).toEqual({ attribute: "label", operator: "eq", value: "true" });

    const matched = await testEval(rule, { label: "true" });
    expect(matched.variant).toBe("on");

    const booleanTrue = await testEval(rule, { label: true });
    expect(booleanTrue.variant).toBe("off");
    expect(booleanTrue.reason).toEqual({ type: "no_match_default" });
  });
});
