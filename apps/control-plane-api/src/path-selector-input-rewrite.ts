/**
 * Rewrite the parsed request input so handlers only ever see canonical IDs.
 * Split from `path-selector-resolution.ts` so that file stays under the
 * file-size ratchet (300 code lines); these helpers read parsed input only and
 * never touch the database.
 */

export function withResolvedInput(
  input: unknown,
  rawParams: Record<string, string>,
  resolvedParams: Record<string, string>,
  environmentIds: readonly string[] | undefined,
  environmentId: string | undefined,
): unknown {
  return withResolvedQueryEnvironmentId(
    withResolvedEnvironmentIds(
      withResolvedParams(input, rawParams, resolvedParams),
      environmentIds,
    ),
    environmentId,
  );
}

function withResolvedQueryEnvironmentId(
  input: unknown,
  environmentId: string | undefined,
): unknown {
  if (environmentId === undefined) return input;
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Environment selector resolver received non-object parsed input");
  }
  const query = "query" in input ? input.query : undefined;
  if (!query || typeof query !== "object" || Array.isArray(query)) {
    throw new Error("Environment selector resolver received parsed input without object query");
  }
  return { ...input, query: { ...query, environmentId } };
}

function withResolvedParams(
  input: unknown,
  rawParams: Record<string, string>,
  resolvedParams: Record<string, string>,
): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("path selector resolver received non-object parsed input");
  }
  if (Object.keys(rawParams).length === 0) return input;
  const parsedParams = "params" in input ? input.params : undefined;
  if (!parsedParams || typeof parsedParams !== "object" || Array.isArray(parsedParams)) {
    throw new Error("path selector resolver received parsed input without object params");
  }
  const replacements = Object.fromEntries(
    Object.entries(resolvedParams).filter(([name, value]) => rawParams[name] !== value),
  );
  return Object.keys(replacements).length === 0
    ? input
    : { ...input, params: { ...parsedParams, ...replacements } };
}

function withResolvedEnvironmentIds(
  input: unknown,
  environmentIds: readonly string[] | undefined,
): unknown {
  if (environmentIds === undefined) return input;
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Environment selector resolver received non-object parsed input");
  }
  const query = "query" in input ? input.query : undefined;
  if (!query || typeof query !== "object" || Array.isArray(query)) {
    throw new Error("Environment selector resolver received parsed input without object query");
  }
  const envs = environmentIds.join(",");
  return { ...input, query: { ...query, envs } };
}

export function environmentSelectorsFromInput(
  contractId: string,
  input: unknown,
): string[] | undefined {
  if (contractId !== "flags_list" && contractId !== "flags_get") return undefined;
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Environment selector resolver received non-object parsed input");
  }
  const query = "query" in input ? input.query : undefined;
  if (!query || typeof query !== "object" || Array.isArray(query)) return undefined;
  const envs = "envs" in query ? query.envs : undefined;
  if (envs === undefined) return undefined;
  if (typeof envs !== "string") {
    throw new Error("Environment selector resolver received invalid envs query");
  }
  return envs.split(",");
}

export function environmentSelectorFromInput(
  contractId: string,
  input: unknown,
): string | undefined {
  if (contractId !== "flags_list") return undefined;
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Environment selector resolver received non-object parsed input");
  }
  const query = "query" in input ? input.query : undefined;
  if (!query || typeof query !== "object" || Array.isArray(query)) return undefined;
  const environmentId = "environmentId" in query ? query.environmentId : undefined;
  if (environmentId === undefined) return undefined;
  if (typeof environmentId !== "string") {
    throw new Error("Environment selector resolver received invalid environmentId query");
  }
  return environmentId;
}
