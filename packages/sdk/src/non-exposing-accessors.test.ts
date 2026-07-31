import { describe, expect, it } from "vitest";
import { createSplitchClient, type SplitchClient } from "./client";
import { type ResolutionDetails, ResolutionDetailsSchema } from "./generated/contract-surface.js";
import {
  FakeLogger,
  FakeTransport,
  httpError,
  ok,
  verifyHttpError,
  verifyOk,
} from "./test-fixtures";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;

const assertClientSurface: Assert<
  Equal<keyof SplitchClient, "evaluate" | "evaluateDetails" | "peekVariant" | "verify">
> = true;
type PublicModule = typeof import("./index");
const assertModuleSurface: Assert<
  Equal<
    keyof PublicModule,
    | "createSplitchClient"
    | "formatSdkErrorMessage"
    | "resolveErrorDocsUrl"
    | "sdkClientErrorCodes"
    | "sdkErrorCodes"
    | "SplitchSdkError"
  >
> = true;

const VERIFY_SPLIT: ResolutionDetails = {
  value: "verified",
  variantName: "treatment",
  reason: "SPLIT",
};

const VERIFY_ERROR: ResolutionDetails = {
  value: "control",
  variantName: null,
  reason: "ERROR",
  errorCode: "SERVICE_UNAVAILABLE",
  errorMessage: "provider unavailable",
};

function apiClient(fake: FakeTransport, logger = new FakeLogger()) {
  return { logger, client: createSplitchClient({ apiKey: "ak_test", transport: fake, logger }) };
}

describe("peekVariant / verify: non-exposing accessors", () => {
  it("peekVariant returns a Variant without an Exposure call or seen-set write", async () => {
    const fake = new FakeTransport([ok("exposed", "run-1")], {
      peek: [ok("peeked", "ignored")],
    });
    const { client } = apiClient(fake);

    await expect(client.peekVariant("checkout", { targetingKey: "u1" })).resolves.toBe("peeked");
    expect(fake.peekCalls).toHaveLength(1);
    expect(fake.evaluateCalls).toHaveLength(0);

    await expect(
      client.evaluate("checkout", { targetingKey: "u1", idempotencyKey: "eval-peek" }),
    ).resolves.toBe("exposed");
    expect(fake.evaluateCalls).toHaveLength(1);
  });

  it("verify returns details without an Exposure call or seen-set write", async () => {
    const fake = new FakeTransport([ok("exposed", "run-1")], {
      verify: [verifyOk(VERIFY_SPLIT)],
    });
    const { client } = apiClient(fake);

    await expect(client.verify("checkout", { targetingKey: "u1" })).resolves.toEqual(VERIFY_SPLIT);
    expect(fake.verifyCalls).toHaveLength(1);
    expect(fake.evaluateCalls).toHaveLength(0);

    await expect(
      client.evaluate("checkout", { targetingKey: "u1", idempotencyKey: "eval-verify" }),
    ).resolves.toBe("exposed");
    expect(fake.evaluateCalls).toHaveLength(1);
  });
});

describe("verify: fail-loud ResolutionDetails normalization", () => {
  it("returns one ResolutionDetails shape for in-band ERROR and transport 503", async () => {
    const fake = new FakeTransport([], {
      verify: [verifyOk(VERIFY_ERROR), verifyHttpError(503)],
    });
    const { client, logger } = apiClient(fake);

    const inBand = await client.verify("checkout", {
      targetingKey: "u1",
      defaultValue: "control",
    });
    const unavailable = await client.verify("checkout", {
      targetingKey: "u2",
      defaultValue: "control",
    });

    expect(inBand).toEqual(VERIFY_ERROR);
    expect(unavailable).toMatchObject({
      value: "control",
      variantName: null,
      reason: "ERROR",
      errorCode: "SERVICE_UNAVAILABLE",
    });
    expect(ResolutionDetailsSchema.safeParse(inBand).success).toBe(true);
    expect(ResolutionDetailsSchema.safeParse(unavailable).success).toBe(true);
    expect(logger.errors).toHaveLength(2);
  });
});

describe("peekVariant: fail-loud errors without Default Variant fallback", () => {
  it.each([
    { status: 404, code: "FLAG_NOT_FOUND" },
    { status: 503, code: "SERVICE_UNAVAILABLE" },
  ] as const)("surfaces HTTP $status as $code", async ({ status, code }) => {
    const fake = new FakeTransport([], { peek: [httpError(status)] });
    const { client, logger } = apiClient(fake);

    await expect(
      client.peekVariant("checkout", { targetingKey: "u1", defaultValue: "control" }),
    ).rejects.toMatchObject({
      name: "SplitchSdkError",
      status,
      code,
    });
    expect(fake.evaluateCalls).toHaveLength(0);
    expect(logger.errors).toHaveLength(1);
  });

  it("surfaces Client Key 403 INSUFFICIENT_SCOPES from the peek route", async () => {
    const fake = new FakeTransport([], {
      peek: [httpError(403, "INSUFFICIENT_SCOPES", "API Key required for this route")],
    });
    const client = createSplitchClient({
      clientKey: "ck_test",
      transport: fake,
      logger: new FakeLogger(),
    });

    await expect(client.peekVariant("checkout", { targetingKey: "u1" })).rejects.toMatchObject({
      name: "SplitchSdkError",
      status: 403,
      code: "INSUFFICIENT_SCOPES",
      causeSummary: "API Key required for this route.",
      message: expect.stringContaining("API Key required for this route"),
      remediation: expect.stringMatching(/\.$/),
    });
  });
});

describe("public SDK surface guard", () => {
  it("exports the client, actionable error contract, and four client accessors", async () => {
    const publicSdk = await import("./index");
    const fake = new FakeTransport([]);
    const client = createSplitchClient({
      apiKey: "ak_test",
      transport: fake,
      logger: new FakeLogger(),
    });

    const surface = [...Object.keys(publicSdk), ...Object.keys(client)].sort();
    expect(surface).toEqual(
      [
        "SplitchSdkError",
        "createSplitchClient",
        "evaluate",
        "evaluateDetails",
        "formatSdkErrorMessage",
        "peekVariant",
        "resolveErrorDocsUrl",
        "sdkClientErrorCodes",
        "sdkErrorCodes",
        "verify",
      ].sort(),
    );
    expect(assertClientSurface).toBe(true);
    expect(assertModuleSurface).toBe(true);

    for (const deferred of ["evaluateAll", "track", "setProvider", "hooks"]) {
      expect(deferred in publicSdk).toBe(false);
      expect(deferred in client).toBe(false);
    }
  });
});
