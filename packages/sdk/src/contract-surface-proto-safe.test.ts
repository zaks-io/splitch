import { describe, expect, it } from "vitest";
// biome-ignore lint/performance/noNamespaceImport: the guard derives roots from runtime exports
import * as contractsSurface from "../../contracts/src/sdk-data-plane-surface";
// biome-ignore lint/performance/noNamespaceImport: the guard derives counterparts from runtime exports
import * as compiledSurface from "./generated/contract-surface.js";

type Issue = {
  readonly code?: unknown;
  readonly message?: unknown;
  readonly path?: readonly PropertyKey[];
};

type ParseResult = {
  readonly success: boolean;
  readonly error?: Error & { readonly issues?: readonly Issue[] };
};

type SchemaDefinition = {
  readonly type?: string;
  readonly shape?: unknown;
  readonly innerType?: unknown;
  readonly options?: unknown;
  readonly in?: unknown;
  readonly out?: unknown;
};

type Schema = {
  readonly def?: SchemaDefinition;
  readonly _zod?: { readonly def?: SchemaDefinition };
  safeParse(input: unknown): ParseResult;
};

const OWN_PROTO_KEY = "__proto__";

function isSchema(value: unknown): value is Schema {
  return (
    typeof value === "object" &&
    value !== null &&
    "safeParse" in value &&
    typeof value.safeParse === "function"
  );
}

function schemaDefinition(schema: Schema): SchemaDefinition {
  return schema.def ?? schema._zod?.def ?? {};
}

function ownProtoRecord(): Record<string, unknown> {
  return JSON.parse(`{"${OWN_PROTO_KEY}":null}`) as Record<string, unknown>;
}

function protoSafeIssue(schema: Schema): Issue | undefined {
  const result = schema.safeParse(ownProtoRecord());
  return result.error?.issues?.find(
    (issue) => issue.code === "custom" && issue.path?.includes(OWN_PROTO_KEY),
  );
}

function objectShape(definition: SchemaDefinition): Record<string, unknown> {
  const shape = typeof definition.shape === "function" ? definition.shape() : definition.shape;
  if (typeof shape !== "object" || shape === null) {
    throw new Error("object schema has no shape");
  }
  return shape as Record<string, unknown>;
}

function objectGuardedPaths(
  definition: SchemaDefinition,
  path: readonly string[],
  visiting: Set<Schema>,
): readonly (readonly string[])[] {
  return Object.entries(objectShape(definition)).flatMap(([key, child]) =>
    isSchema(child) ? guardedRecordPaths(child, [...path, key], visiting) : [],
  );
}

function transparentSchemas(definition: SchemaDefinition): readonly Schema[] {
  const candidates = [definition.innerType, definition.in, definition.out];
  if (Array.isArray(definition.options)) {
    candidates.push(...definition.options);
  }
  return candidates.filter(isSchema);
}

function guardedRecordPaths(
  schema: Schema,
  path: readonly string[] = [],
  visiting: Set<Schema> = new Set(),
): readonly (readonly string[])[] {
  if (visiting.has(schema)) {
    return [];
  }
  visiting.add(schema);

  const definition = schemaDefinition(schema);
  let paths: readonly (readonly string[])[];
  if (definition.type === "record") {
    paths = protoSafeIssue(schema) === undefined ? [] : [path];
  } else if (definition.type === "object") {
    paths = objectGuardedPaths(definition, path, visiting);
  } else {
    paths = transparentSchemas(definition).flatMap((child) =>
      guardedRecordPaths(child, path, visiting),
    );
  }
  visiting.delete(schema);
  return paths;
}

function objectSample(definition: SchemaDefinition): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(objectShape(definition)).flatMap(([key, child]) => {
      if (!isSchema(child)) {
        return [];
      }
      const childType = schemaDefinition(child).type;
      return childType === "optional" || childType === "default" ? [] : [[key, sampleValue(child)]];
    }),
  );
}

function unionSample(definition: SchemaDefinition): unknown {
  if (!Array.isArray(definition.options)) {
    throw new Error("union schema has no options");
  }
  for (const option of definition.options) {
    if (isSchema(option)) {
      const candidate = sampleValue(option);
      if (option.safeParse(candidate).success) {
        return candidate;
      }
    }
  }
  throw new Error("union schema has no sampleable option");
}

function sampleValue(schema: Schema): unknown {
  const definition = schemaDefinition(schema);
  if (definition.type === "object") {
    return objectSample(definition);
  }
  if (definition.type === "record") {
    return {};
  }
  if (definition.type === "nullable" || definition.type === "null") {
    return null;
  }
  if (definition.type === "string") {
    return "value";
  }
  if (definition.type === "number") {
    return 0;
  }
  if (definition.type === "boolean") {
    return false;
  }
  if (definition.type === "array") {
    return [];
  }
  if (definition.type === "union") {
    return unionSample(definition);
  }
  if (isSchema(definition.innerType)) {
    return sampleValue(definition.innerType);
  }
  throw new Error(`cannot sample zod schema type ${String(definition.type)}`);
}

function inputWithOwnProtoAt(base: unknown, path: readonly string[]): unknown {
  if (path.length === 0) {
    return ownProtoRecord();
  }
  const input = structuredClone(base) as Record<string, unknown>;
  let parent = input;
  for (const segment of path.slice(0, -1)) {
    const child = parent[segment];
    if (typeof child !== "object" || child === null || Array.isArray(child)) {
      parent[segment] = {};
    }
    parent = parent[segment] as Record<string, unknown>;
  }
  const leaf = path.at(-1);
  if (leaf === undefined) {
    throw new Error("guarded record path has no leaf");
  }
  parent[leaf] = ownProtoRecord();
  return input;
}

function derivedContractRoots(
  contractExports: Record<string, unknown>,
  compiledExports: Record<string, unknown>,
): ReadonlyMap<string, Schema> {
  const roots = new Map<string, Schema>();
  for (const [name, compiled] of Object.entries(compiledExports)) {
    const contract = contractExports[name];
    if (name.endsWith("Schema") && isSchema(compiled) && isSchema(contract)) {
      roots.set(name, contract);
    }
  }
  for (const [name, contract] of Object.entries(contractExports)) {
    if (
      name.endsWith("ResponseSchema") &&
      isSchema(contract) &&
      guardedRecordPaths(contract).length > 0
    ) {
      roots.set(name, contract);
    }
  }
  return roots;
}

function assertGuardedPath(
  name: string,
  contract: Schema,
  compiled: Schema,
  base: unknown,
  path: readonly string[],
): void {
  const input = inputWithOwnProtoAt(base, path);
  const contractResult = contract.safeParse(input);
  const compiledResult = compiled.safeParse(input);
  const issue = contractResult.error?.issues?.find(
    (candidate) => candidate.code === "custom" && candidate.path?.includes(OWN_PROTO_KEY),
  );
  const label = `${name}.${path.join(".")}`;

  expect(contractResult.success, `${label} contract accepted __proto__`).toBe(false);
  expect(issue, `${label} lost its proto-safe issue`).toBeDefined();
  expect(compiledResult.success, `${label} SDK accepted __proto__`).toBe(false);
  if (issue !== undefined && compiledResult.error !== undefined) {
    expect(compiledResult.error.message).toBe(issue.message);
  }
}

function assertGuardedRoot(
  name: string,
  contract: Schema,
  compiledExports: Record<string, unknown>,
): number {
  const paths = guardedRecordPaths(contract);
  if (paths.length === 0) {
    return 0;
  }
  const compiled = compiledExports[name];
  expect(isSchema(compiled), `${name} has no compiled SDK counterpart`).toBe(true);
  if (!isSchema(compiled)) {
    return paths.length;
  }

  const base = sampleValue(contract);
  expect(contract.safeParse(base).success, `${name} contract sample is invalid`).toBe(true);
  expect(compiled.safeParse(base).success, `${name} compiled sample is invalid`).toBe(true);
  for (const path of paths) {
    assertGuardedPath(name, contract, compiled, base, path);
  }
  return paths.length;
}

describe("contract-surface proto-safe refinements", () => {
  it("derives guarded contract paths and requires the compiled parser to refuse them", () => {
    const contractExports = contractsSurface as Record<string, unknown>;
    const compiledExports = compiledSurface as Record<string, unknown>;
    const roots = derivedContractRoots(contractExports, compiledExports);
    const guardedPathCount = [...roots].reduce(
      (count, [name, contract]) => count + assertGuardedRoot(name, contract, compiledExports),
      0,
    );

    expect(guardedPathCount, "no proto-safe contract records were derived").toBeGreaterThan(0);
  });
});
