type ParseResult = {
  readonly success: boolean;
  readonly error?: Error & { readonly issues?: readonly { readonly message?: unknown }[] };
};

type SchemaDefinition = {
  readonly type?: string;
  readonly checks?: readonly unknown[];
  readonly shape?: unknown;
  readonly element?: unknown;
  readonly valueType?: unknown;
  readonly options?: unknown;
  readonly innerType?: unknown;
  readonly in?: unknown;
  readonly out?: unknown;
};

export type Schema = {
  readonly def?: SchemaDefinition;
  readonly _zod?: { readonly def?: SchemaDefinition };
  safeParse(input: unknown): ParseResult;
};

export type Refinement = {
  readonly rootName: string;
  readonly schemaName: string;
  readonly path: readonly string[];
  readonly index: number;
  readonly message?: string;
  readonly check: (payload: { value: unknown; issues: unknown[] }) => unknown;
};

type Child = { readonly schema: Schema; readonly segment?: string };
type DiscoveryState = {
  readonly names: ReadonlyMap<Schema, string>;
  readonly refinements: Refinement[];
  readonly visited: Set<Schema>;
};

export function isSchema(value: unknown): value is Schema {
  return (
    typeof value === "object" &&
    value !== null &&
    "safeParse" in value &&
    typeof value.safeParse === "function"
  );
}

function definition(schema: Schema): SchemaDefinition {
  return schema.def ?? schema._zod?.def ?? {};
}

function objectShape(def: SchemaDefinition): Record<string, unknown> {
  const shape = typeof def.shape === "function" ? def.shape() : def.shape;
  return typeof shape === "object" && shape !== null ? (shape as Record<string, unknown>) : {};
}

function renderMessage(def: Record<string, unknown>): string | undefined {
  const rendered = typeof def.error === "function" ? def.error({}) : undefined;
  if (typeof rendered === "string") return rendered;
  if (typeof rendered === "object" && rendered !== null && "message" in rendered) {
    return String(rendered.message);
  }
  return undefined;
}

function refineCheck(value: unknown): {
  readonly check: (payload: { value: unknown; issues: unknown[] }) => unknown;
  readonly message?: string;
} | null {
  if (typeof value !== "object" || value === null || !("_zod" in value)) return null;
  const internals = (
    value as {
      readonly _zod?: {
        readonly def?: Record<string, unknown>;
        readonly check?: (payload: { value: unknown; issues: unknown[] }) => unknown;
      };
    }
  )._zod;
  const def = internals?.def;
  if (def?.check !== "custom" || typeof internals?.check !== "function") return null;
  const message = renderMessage(def);
  return {
    check: internals.check,
    ...(message === undefined ? {} : { message }),
  };
}

function objectChildren(def: SchemaDefinition): readonly Child[] {
  if (def.type !== "object") return [];
  return Object.entries(objectShape(def)).flatMap(([segment, value]) =>
    isSchema(value) ? [{ schema: value, segment }] : [],
  );
}

function typedChild(
  def: SchemaDefinition,
  type: string,
  candidate: unknown,
  segment: string,
): readonly Child[] {
  return def.type === type && isSchema(candidate) ? [{ schema: candidate, segment }] : [];
}

function optionChildren(def: SchemaDefinition): readonly Child[] {
  return Array.isArray(def.options)
    ? def.options.flatMap((value) => (isSchema(value) ? [{ schema: value }] : []))
    : [];
}

function transparentChildren(def: SchemaDefinition): readonly Child[] {
  return [def.innerType, def.in, def.out].flatMap((value) =>
    isSchema(value) ? [{ schema: value }] : [],
  );
}

function schemaChildren(def: SchemaDefinition): readonly Child[] {
  return [
    ...objectChildren(def),
    ...typedChild(def, "array", def.element, "[]"),
    ...typedChild(def, "record", def.valueType, "*"),
    ...optionChildren(def),
    ...transparentChildren(def),
  ];
}

function appendRefinements(
  state: DiscoveryState,
  rootName: string,
  schema: Schema,
  path: readonly string[],
  def: SchemaDefinition,
): void {
  let index = 0;
  for (const candidate of def.checks ?? []) {
    const check = refineCheck(candidate);
    if (check === null) continue;
    state.refinements.push({
      rootName,
      schemaName: state.names.get(schema) ?? `${rootName}.${path.join(".")}`,
      path,
      index,
      ...check,
    });
    index += 1;
  }
}

function walk(
  state: DiscoveryState,
  rootName: string,
  schema: Schema,
  path: readonly string[],
): void {
  if (state.visited.has(schema)) return;
  state.visited.add(schema);
  const def = definition(schema);
  appendRefinements(state, rootName, schema, path, def);
  for (const child of schemaChildren(def)) {
    walk(
      state,
      rootName,
      child.schema,
      child.segment === undefined ? path : [...path, child.segment],
    );
  }
}

function schemaNames(contractExports: Record<string, unknown>): ReadonlyMap<Schema, string> {
  const names = new Map<Schema, string>();
  for (const [name, value] of Object.entries(contractExports)) {
    if (name.endsWith("Schema") && isSchema(value)) names.set(value, name);
  }
  return names;
}

function contractRoots(
  contractExports: Record<string, unknown>,
  compiledExports: Record<string, unknown>,
): ReadonlyMap<string, Schema> {
  const roots = new Map<string, Schema>();
  for (const [name, compiled] of Object.entries(compiledExports).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const contract = contractExports[name];
    if (name.endsWith("Schema") && isSchema(compiled) && isSchema(contract))
      roots.set(name, contract);
  }
  return roots;
}

export function discoverRefinements(
  contractExports: Record<string, unknown>,
  compiledExports: Record<string, unknown>,
): { readonly refinements: readonly Refinement[]; readonly roots: ReadonlyMap<string, Schema> } {
  const roots = contractRoots(contractExports, compiledExports);
  const state: DiscoveryState = {
    names: schemaNames(contractExports),
    refinements: [],
    visited: new Set(),
  };
  for (const [rootName, schema] of roots) walk(state, rootName, schema, []);
  return { refinements: state.refinements, roots };
}

function valuesForSegment(value: unknown, segment: string): readonly unknown[] {
  if (segment === "[]") return Array.isArray(value) ? value : [];
  if (segment === "*") {
    return typeof value === "object" && value !== null ? Object.values(value) : [];
  }
  return typeof value === "object" && value !== null && segment in value
    ? [(value as Record<string, unknown>)[segment]]
    : [];
}

function valuesAtPath(input: unknown, path: readonly string[]): readonly unknown[] {
  let values: readonly unknown[] = [input];
  for (const segment of path) values = values.flatMap((value) => valuesForSegment(value, segment));
  return values;
}

export function refinementRejects(refinement: Refinement, input: unknown): boolean {
  return valuesAtPath(input, refinement.path).some((value) => {
    const payload = { value, issues: [] };
    const result = refinement.check(payload);
    if (result instanceof Promise) {
      throw new Error(`${refinement.schemaName}: async refine is unsupported`);
    }
    return payload.issues.length > 0;
  });
}
