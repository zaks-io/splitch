import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const SHARED_PREVIEW_TARGET = "shared-preview";

const PLACEHOLDER_KV_ID = "00000000000000000000000000000000";
const PLACEHOLDER_D1_ID = "00000000-0000-0000-0000-000000000000";

export function createResetPlan(root) {
  const appsDir = join(root, "apps");
  const configs = readdirSync(appsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      path: join(appsDir, entry.name, "wrangler.jsonc"),
      source: `apps/${entry.name}/wrangler.jsonc`,
    }))
    .filter(({ path }) => {
      try {
        parseWranglerConfigFile(path);
        return true;
      } catch (error) {
        if (error?.code === "ENOENT") return false;
        throw error;
      }
    });
  const dbConfigPath = join(root, "packages", "db", "wrangler.jsonc");
  const dbConfig = parseWranglerConfigFile(dbConfigPath);
  const resources = configs.map(({ path, source }) => ({
    config: parseWranglerConfigFile(path),
    source,
  }));
  const forbiddenIds = collectForbiddenIds(resources, dbConfig);
  const kvIds = new Set();
  const d1Ids = new Set();

  for (const { config, source } of resources) {
    const target = requirePreviewTarget(config, source);
    collectPreviewIds(target.kv_namespaces, "id", kvIds, forbiddenIds, `${source} KV`);
    collectPreviewIds(target.d1_databases, "database_id", d1Ids, forbiddenIds, `${source} D1`);
  }
  const dbTarget = requirePreviewTarget(dbConfig, "packages/db/wrangler.jsonc", false);
  collectPreviewIds(dbTarget.d1_databases, "database_id", d1Ids, forbiddenIds, "packages/db D1");

  if (kvIds.size === 0) throw new Error("no shared-preview KV namespaces were found");
  if (d1Ids.size !== 1) {
    throw new Error(`reset requires exactly one shared-preview D1 database, found ${d1Ids.size}`);
  }

  return {
    d1Id: [...d1Ids][0],
    dbConfigPath,
    dbDir: dirname(dbConfigPath),
    kvIds: [...kvIds].sort(),
  };
}

function collectForbiddenIds(resources, dbConfig) {
  const forbiddenIds = new Set();
  for (const { config, source } of resources) {
    collectIds(config.kv_namespaces, "id", forbiddenIds);
    collectIds(config.d1_databases, "database_id", forbiddenIds);
    const production = config.env?.production;
    if (!production) throw new Error(`${source} must declare env.production before reset`);
    collectIds(production.kv_namespaces, "id", forbiddenIds);
    collectIds(production.d1_databases, "database_id", forbiddenIds);
  }
  const dbProduction = dbConfig.env?.production;
  if (!dbProduction) {
    throw new Error("packages/db/wrangler.jsonc must declare env.production before reset");
  }
  collectIds(dbConfig.d1_databases, "database_id", forbiddenIds);
  collectIds(dbProduction.d1_databases, "database_id", forbiddenIds);
  return forbiddenIds;
}

function requirePreviewTarget(config, source, requirePlatformTarget = true) {
  const target = config.env?.[SHARED_PREVIEW_TARGET];
  if (!target) throw new Error(`${source} must declare env.${SHARED_PREVIEW_TARGET} before reset`);
  if (requirePlatformTarget && target.vars?.SPLITCH_PLATFORM_TARGET !== SHARED_PREVIEW_TARGET) {
    throw new Error(
      `${source} env.${SHARED_PREVIEW_TARGET} must positively identify SPLITCH_PLATFORM_TARGET`,
    );
  }
  if (requirePlatformTarget && !String(target.name ?? "").endsWith(`-${SHARED_PREVIEW_TARGET}`)) {
    throw new Error(`${source} env.${SHARED_PREVIEW_TARGET} must use a shared-preview Worker name`);
  }
  return target;
}

function collectIds(bindings, field, target) {
  if (!Array.isArray(bindings)) return;
  for (const binding of bindings) {
    const id = binding?.[field];
    if (typeof id === "string" && id.length > 0) target.add(id);
  }
}

function collectPreviewIds(bindings, field, target, forbiddenIds, source) {
  if (!Array.isArray(bindings)) return;
  for (const binding of bindings) {
    const id = binding?.[field];
    if (typeof id !== "string" || id.length === 0) {
      throw new Error(`${source} is missing its shared-preview resource identifier`);
    }
    if (id === PLACEHOLDER_KV_ID || id === PLACEHOLDER_D1_ID || id.startsWith("local-")) {
      throw new Error(`${source} uses a local placeholder instead of a shared-preview resource`);
    }
    if (forbiddenIds.has(id)) {
      throw new Error(`${source} overlaps a production or local resource identifier`);
    }
    target.add(id);
  }
}

function parseWranglerConfigFile(path) {
  const text = readFileSync(path, "utf8");
  try {
    return JSON.parse(stripJsonComments(text));
  } catch (error) {
    throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function stripJsonComments(input) {
  let output = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < input.length; index += 1) {
    const current = input[index];
    const next = input[index + 1];
    if (inString) {
      output += current;
      [inString, escaped] = advanceStringState(current, escaped);
      continue;
    }
    if (current === '"') {
      inString = true;
      output += current;
      continue;
    }
    const commentEnd = findCommentEnd(input, index, current, next);
    if (commentEnd !== undefined) {
      index = commentEnd;
      continue;
    }
    output += current;
  }
  return output;
}

function advanceStringState(current, escaped) {
  if (escaped) return [true, false];
  if (current === "\\") return [true, true];
  return [current !== '"', false];
}

function findCommentEnd(input, index, current, next) {
  if (current !== "/") return undefined;
  if (next === "/") return skipLineComment(input, index);
  if (next === "*") return skipBlockComment(input, index);
  return undefined;
}

function skipLineComment(input, index) {
  while (index + 1 < input.length && input[index + 1] !== "\n") index += 1;
  return index;
}

function skipBlockComment(input, index) {
  index += 2;
  while (index < input.length && !(input[index] === "*" && input[index + 1] === "/")) {
    index += 1;
  }
  return index + 1;
}
