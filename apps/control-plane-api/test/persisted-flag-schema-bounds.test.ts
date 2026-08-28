import {
  PERSISTED_ARRAY_MAX_ITEMS,
  PERSISTED_JSON_MAX_DEPTH,
  PERSISTED_RECORD_KEY_MAX_LENGTH,
  PERSISTED_RECORD_MAX_KEYS,
  PERSISTED_VARIANT_VALUE_STRING_MAX_LENGTH,
} from "@splitch/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appToken,
  createDefaultApp,
  createFlag,
  errorBody,
  type FlagDefinitionHarness,
  makeFlagDefinitionHarness,
  request,
} from "../src/flag-definition-test-harness";
import { makePoolBindings as makeLocalBindings } from "./pool-bindings";

let h: FlagDefinitionHarness;

beforeEach(async () => {
  h = await makeFlagDefinitionHarness(makeLocalBindings);
});

afterEach(async () => h.bindings.dispose());

const overflowSchema = {
  overflow: nest("leaf", PERSISTED_JSON_MAX_DEPTH),
};

const cases: Array<{ name: string; schema: Record<string, unknown>; path: string }> = [
  {
    name: "over-limit nested string",
    schema: { title: "s".repeat(PERSISTED_VARIANT_VALUE_STRING_MAX_LENGTH + 1) },
    path: "body.schema.title",
  },
  {
    name: "over-limit nested array",
    schema: {
      enum: Array.from({ length: PERSISTED_ARRAY_MAX_ITEMS + 1 }, (_, index) => `v${index}`),
    },
    path: "body.schema.enum",
  },
  {
    name: "over-limit nested record keys",
    schema: {
      properties: Object.fromEntries(
        Array.from({ length: PERSISTED_RECORD_MAX_KEYS + 1 }, (_, index) => [
          `k${index}`,
          { type: "string" },
        ]),
      ),
    },
    path: "body.schema.properties",
  },
  {
    name: "over-limit nested key length",
    schema: {
      properties: { ["k".repeat(PERSISTED_RECORD_KEY_MAX_LENGTH + 1)]: { type: "string" } },
    },
    path: `body.schema.properties.${"k".repeat(PERSISTED_RECORD_KEY_MAX_LENGTH + 1)}`,
  },
  {
    name: "over-limit nested depth",
    schema: overflowSchema,
    path: `body.schema.overflow${".child".repeat(PERSISTED_JSON_MAX_DEPTH - 1)}`,
  },
];

describe("control-plane Flag schema write bounds", () => {
  it.each(cases)("rejects $name on create before any Flag write", async ({ schema, path }) => {
    const created = await createDefaultApp(h);
    const jwt = await appToken(h, created.app.id);
    const before = await flagCount(created.app.id);
    const res = await request(h, "POST", `/apps/${created.app.id}/flags`, jwt, {
      appId: created.app.id,
      name: "Bounded schema",
      key: "bounded-schema-flag",
      schema,
      variants: [{ name: "control", value: false, isDefault: true }],
      idempotency_key: `idem-schema-${path}`,
    });

    expect(res.status).toBe(400);
    const err = await errorBody(res);
    expect(err.code).toBe("VALIDATION_ERROR");
    if (err.code !== "VALIDATION_ERROR") return;
    expect(err.details.issues.some((issue) => issue.path.join(".") === path)).toBe(true);
    expect(await flagCount(created.app.id)).toBe(before);
  });

  it.each(cases)("rejects $name on patch before any Flag write", async ({ schema, path }) => {
    const created = await createDefaultApp(h);
    const jwt = await appToken(h, created.app.id);
    const flag = await createFlag(h, created.app.id, jwt);
    const before = await flagSchema(flag.id);
    const res = await request(h, "PATCH", `/apps/${created.app.id}/flags/${flag.id}`, jwt, {
      schema,
    });

    expect(res.status).toBe(400);
    const err = await errorBody(res);
    expect(err.code).toBe("VALIDATION_ERROR");
    if (err.code !== "VALIDATION_ERROR") return;
    expect(err.details.issues.some((issue) => issue.path.join(".") === path)).toBe(true);
    expect(await flagSchema(flag.id)).toBe(before);
  });
});

function nest(leaf: unknown, depth: number): unknown {
  let nested = leaf;
  for (let current = 1; current < depth; current += 1) {
    nested = { child: nested };
  }
  return nested;
}

async function flagCount(appId: string): Promise<number> {
  const row = await h.bindings.d1
    .prepare("SELECT COUNT(*) AS n FROM flags WHERE app_id = ?")
    .bind(appId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

async function flagSchema(flagId: string): Promise<string | null> {
  const row = await h.bindings.d1
    .prepare("SELECT schema FROM flags WHERE id = ?")
    .bind(flagId)
    .first<{ schema: string | null }>();
  return row?.schema ?? null;
}
