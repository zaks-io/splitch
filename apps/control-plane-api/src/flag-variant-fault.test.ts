import { inspect } from "node:util";
import { appScope, createRepository, type Repository } from "@splitch/db";
import { __setSentryModuleForTests } from "@splitch/observability/sentry-module";
import {
  createWorkerFaultReporter,
  createWorkerObservability,
  serializeFault,
} from "@splitch/observability/worker";
import { PUBLIC_PRINCIPAL } from "@splitch/worker-runtime";
import { afterEach, expect, it, vi } from "vitest";
import { createRequestHash } from "./create-idempotency";
import { createFlag } from "./flag-definition-create";

const canary = "customer-Variant-canary";

afterEach(() => {
  __setSentryModuleForTests(undefined);
  vi.restoreAllMocks();
});

it("withholds the Variant name interpolated by ensureCreateVariants", async () => {
  const statement = {
    bind: vi.fn().mockReturnThis(),
    raw: vi
      .fn()
      .mockResolvedValueOnce([
        [
          "flag_1",
          "app_1",
          "checkout",
          "Checkout",
          null,
          null,
          "variant_1",
          "ops",
          null,
          null,
          null,
          null,
          null,
          "2026-08-30T00:00:00.000Z",
          "2026-08-30T00:00:00.000Z",
          "user_1",
          null,
          1,
        ],
      ])
      .mockResolvedValue([]),
  };
  // Simulate an acknowledged insert whose row is absent on the settled read.
  const batch = vi.fn().mockResolvedValue([{ success: true, results: [] }]);
  const repo = createRepository({
    prepare: vi.fn(() => statement),
    batch,
  } as unknown as D1Database);
  const failure = await repo.flags
    .ensureCreateVariants(appScope("app_1"), "flag_1", [
      {
        id: "variant_1",
        name: canary,
        value: "false",
        createdAt: "2026-08-30T00:00:00.000Z",
      },
    ])
    .catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toBe(
    `ensureCreateVariants: Variant ${canary} was not created`,
  );
  expect(statement.raw).toHaveBeenCalledTimes(3);
  expect(batch).toHaveBeenCalledOnce();
  await expectPrivateFault(failure);
});

it("withholds the Variant name interpolated by flags_create replay", async () => {
  const body = {
    key: "checkout",
    name: "Checkout",
    variants: [{ name: canary, value: false, isDefault: true }],
  };
  const hashed = await createRequestHash(body, "req-replay-fault");
  if (!hashed.ok) throw new Error("test Flag payload could not be hashed");
  const ensureCreateVariants = vi.fn().mockResolvedValue([]);
  const repo = {
    identity: {
      getApp: vi.fn().mockResolvedValue({ id: "app_1" }),
      getAppMembership: vi.fn().mockResolvedValue({ role: "owner" }),
    },
    flags: {
      getFlagCreateByIdempotency: vi.fn().mockResolvedValue({
        id: "flag_1",
        appId: "app_1",
        defaultVariantId: "variant_1",
        createRequestHash: hashed.hash,
        createResponse: null,
      }),
      listVariants: vi.fn().mockResolvedValue([]),
      ensureCreateVariants,
    },
  } as unknown as Repository;
  const failure = await createFlag(
    { repo },
    {
      input: { params: { appId: "app_1" }, body },
      principal: { ...PUBLIC_PRINCIPAL, id: "user_1", scopes: ["app:app_1:owner"] },
      requestId: "req-replay-fault",
      request: new Request("https://control.example/apps/app_1/flags", {
        method: "POST",
        headers: { "idempotency-key": "create-flag-replay" },
      }),
    },
  ).catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toBe(`flags_create replay lost Variant ${canary}`);
  expect(ensureCreateVariants).toHaveBeenCalledWith(appScope("app_1"), "flag_1", [
    expect.objectContaining({ id: "variant_1", name: canary, value: "false" }),
  ]);
  await expectPrivateFault(failure);
});

async function expectPrivateFault(failure: unknown): Promise<void> {
  const captureMessage = vi.fn();
  const addBreadcrumb = vi.fn();
  __setSentryModuleForTests({ captureMessage, addBreadcrumb } as unknown as Parameters<
    typeof __setSentryModuleForTests
  >[0]);
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  const pending: Promise<unknown>[] = [];
  const env = { SENTRY_DSN: "https://example@sentry.io/1" };
  const options = {
    surface: "control-plane-api" as const,
    waitUntil: (promise: Promise<unknown>) => {
      pending.push(promise);
    },
  };
  createWorkerFaultReporter(env, options)("variant_create_failed", {
    fault: serializeFault(failure),
  });
  const observability = createWorkerObservability(env, options);
  for (const status of [500, 400]) {
    observability.onError?.({
      requestId: "req-variant-fault",
      status,
      code: status === 500 ? "INTERNAL_SERVER_ERROR" : "BAD_REQUEST",
      cause: failure,
    });
  }
  await Promise.all(pending);
  expect(captureMessage).toHaveBeenCalledTimes(2);
  expect(addBreadcrumb).toHaveBeenCalledOnce();
  expect(consoleError).toHaveBeenCalledTimes(2);
  for (const calls of [
    captureMessage.mock.calls,
    addBreadcrumb.mock.calls,
    consoleError.mock.calls,
  ]) {
    const emitted = inspect(calls, {
      showHidden: true,
      depth: null,
      maxStringLength: null,
      maxArrayLength: null,
    });
    expect(emitted).toContain("Error: [message withheld]");
    expect(emitted).not.toContain(canary);
    expect(emitted).not.toContain((failure as Error).message);
  }
}
