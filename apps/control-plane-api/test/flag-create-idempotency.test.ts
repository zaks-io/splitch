import { appScope, createRepository, type Repository } from "@splitch/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appToken,
  baseFlag,
  createDefaultApp,
  errorBody,
  type FlagDefinitionHarness,
  makeAppForRepo,
  makeFlagDefinitionHarness,
  request,
} from "../src/flag-definition-test-harness";
import { makePoolBindings as makeLocalBindings } from "./pool-bindings";

let h: FlagDefinitionHarness;

beforeEach(async () => {
  h = await makeFlagDefinitionHarness(makeLocalBindings);
});

afterEach(async () => h.bindings.dispose());

describe("flags_create idempotency", () => {
  it("replays exactly and conflicts when the payload changes", async () => {
    const createdApp = await createDefaultApp(h);
    const jwt = await appToken(h, createdApp.app.id);
    const original = {
      ...baseFlag(createdApp.app.id),
      key: "idempotent-flag",
      idempotency_key: "idem_flag_create_exact",
    };

    const first = await request(h, "POST", `/apps/${createdApp.app.id}/flags`, jwt, original);
    const replay = await request(h, "POST", `/apps/${createdApp.app.id}/flags`, jwt, original);
    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(await first.json());

    const conflict = await request(h, "POST", `/apps/${createdApp.app.id}/flags`, jwt, {
      ...original,
      name: "A different Flag",
    });
    expect(conflict.status).toBe(409);
    expect((await errorBody(conflict)).code).toBe("IDEMPOTENCY_KEY_CONFLICT");
  });

  it("converges concurrent same-key creates on one exact response", async () => {
    const createdApp = await createDefaultApp(h);
    const jwt = await appToken(h, createdApp.app.id);
    synchronizeFirstTwoCreateAttempts(h);
    const body = {
      ...baseFlag(createdApp.app.id),
      key: "concurrent-idempotent-flag",
      idempotency_key: "idem_flag_create_concurrent",
    };

    const [first, second] = await Promise.all([
      request(h, "POST", `/apps/${createdApp.app.id}/flags`, jwt, body),
      request(h, "POST", `/apps/${createdApp.app.id}/flags`, jwt, body),
    ]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(await first.json());
    const flags = await createRepository(h.bindings.d1).flags.flags.findMany(
      appScope(createdApp.app.id),
    );
    expect(flags.filter((flag) => flag.key === body.key)).toHaveLength(1);
  });

  it("returns a typed conflict for concurrent payloads sharing an idempotency key", async () => {
    const createdApp = await createDefaultApp(h);
    const jwt = await appToken(h, createdApp.app.id);
    synchronizeFirstTwoIdempotencyLookups(h);
    const original = {
      ...baseFlag(createdApp.app.id),
      key: "concurrent-original",
      idempotency_key: "idem_flag_create_concurrent_conflict",
    };

    const [first, second] = await Promise.all([
      request(h, "POST", `/apps/${createdApp.app.id}/flags`, jwt, original),
      request(h, "POST", `/apps/${createdApp.app.id}/flags`, jwt, {
        ...original,
        key: "concurrent-different",
        name: "Different concurrent Flag",
      }),
    ]);
    const responses = [first, second];
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    const conflict = responses.find((response) => response.status === 409);
    expect(conflict).toBeDefined();
    expect((await errorBody(conflict as Response)).code).toBe("IDEMPOTENCY_KEY_CONFLICT");
    const flags = await createRepository(h.bindings.d1).flags.flags.findMany(
      appScope(createdApp.app.id),
    );
    expect(
      flags.filter((flag) => flag.createIdempotencyKey === original.idempotency_key),
    ).toHaveLength(1);
  });

  it("resumes after a failure leaves a partial Variant catalog", async () => {
    const createdApp = await createDefaultApp(h);
    const jwt = await appToken(h, createdApp.app.id);
    const repo = createRepository(h.bindings.d1);
    let calls = 0;
    h.app = makeAppForRepo(h, {
      ...repo,
      flags: {
        ...repo.flags,
        ensureCreateVariant: async (...args) => {
          calls += 1;
          if (calls === 2) throw new Error("injected Variant provisioning failure");
          return repo.flags.ensureCreateVariant(...args);
        },
      },
    });
    const body = {
      ...baseFlag(createdApp.app.id),
      key: "recover-partial-catalog",
      idempotency_key: "idem_flag_create_partial_recovery",
    };

    const failed = await request(h, "POST", `/apps/${createdApp.app.id}/flags`, jwt, body);
    expect(failed.status).toBe(500);
    h.app = makeAppForRepo(h, repo);
    const recovered = await request(h, "POST", `/apps/${createdApp.app.id}/flags`, jwt, body);
    expect(recovered.status).toBe(200);
    expect(((await recovered.json()) as { variants: unknown[] }).variants).toHaveLength(2);
  });
});

function synchronizeFirstTwoIdempotencyLookups(harness: FlagDefinitionHarness): void {
  const repo = createRepository(harness.bindings.d1);
  let lookups = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const synchronized: Repository = {
    ...repo,
    flags: {
      ...repo.flags,
      getFlagCreateByIdempotency: async (...args) => {
        const result = await repo.flags.getFlagCreateByIdempotency(...args);
        if (lookups >= 2) return result;
        lookups += 1;
        if (lookups === 2) release();
        await gate;
        return result;
      },
    },
  };
  harness.app = makeAppForRepo(harness, synchronized);
}

function synchronizeFirstTwoCreateAttempts(harness: FlagDefinitionHarness): void {
  const repo = createRepository(harness.bindings.d1);
  let lookups = 0;
  let variantWrites = 0;
  let releaseLookups!: () => void;
  let releaseVariants!: () => void;
  const lookupGate = new Promise<void>((resolve) => {
    releaseLookups = resolve;
  });
  const variantGate = new Promise<void>((resolve) => {
    releaseVariants = resolve;
  });
  const synchronized: Repository = {
    ...repo,
    flags: {
      ...repo.flags,
      getFlagCreateByIdempotency: async (...args) => {
        const result = await repo.flags.getFlagCreateByIdempotency(...args);
        if (lookups >= 2) return result;
        lookups += 1;
        if (lookups === 2) releaseLookups();
        await lookupGate;
        return result;
      },
      ensureCreateVariant: async (...args) => {
        variantWrites += 1;
        if (variantWrites === 2) releaseVariants();
        if (variantWrites <= 2) await variantGate;
        return repo.flags.ensureCreateVariant(...args);
      },
    },
  };
  harness.app = makeAppForRepo(harness, synchronized);
}
