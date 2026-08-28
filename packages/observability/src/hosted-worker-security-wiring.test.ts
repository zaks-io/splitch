import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseConfigFileTextToJson } from "typescript";
import { describe, expect, it } from "vitest";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "../../..");
const WRAPPER = "wrapWorkerHandler";

/** Customer-installable Worker, not a hosted Splitch surface. */
const NON_HOSTED_WRANGLER = new Set(["packages/cloudflare/wrangler.jsonc"]);

interface WranglerConfig {
  name?: string;
  main?: string;
  services?: Array<{ entrypoint?: string }>;
  env?: Record<string, { name?: string; services?: Array<{ entrypoint?: string }> } | undefined>;
}

interface HostedWorker {
  configPath: string;
  name: string;
  mainPath: string;
  source: string;
  referencedEntrypoints: string[];
}

describe("hosted Worker security-header wiring", () => {
  const workers = discoverHostedWorkers(repoRoot);

  it("discovers every Wrangler config that ships a fetch entrypoint", () => {
    expect(workers.length).toBeGreaterThan(0);
    expect(workers.map((worker) => relative(repoRoot, worker.configPath)).sort()).toEqual([
      "apps/analysis-api/wrangler.jsonc",
      "apps/auth-api/wrangler.jsonc",
      "apps/control-panel/wrangler.jsonc",
      "apps/control-plane-api/wrangler.jsonc",
      "apps/evaluation-api/wrangler.jsonc",
      "apps/event-ingest-api/wrangler.jsonc",
      "apps/marketing/wrangler.jsonc",
      "apps/mcp-server/wrangler.jsonc",
    ]);
  });

  it("wraps each discovered default fetch export", () => {
    for (const worker of workers) {
      expect(
        defaultExportIsWrapped(worker.source),
        `${relative(repoRoot, worker.mainPath)} default export must be ${WRAPPER}(...)`,
      ).toBe(true);
    }
  });

  it("wraps every exported WorkerEntrypoint fetch handler", () => {
    for (const worker of workers) {
      for (const className of exportedWorkerEntrypoints(worker.source)) {
        expect(
          classFetchIsWrapped(worker.source, className),
          `${relative(repoRoot, worker.mainPath)} ${className}.fetch must delegate to ${WRAPPER}`,
        ).toBe(true);
      }
    }
  });

  it("resolves every configured service entrypoint to a wrapped exported class", () => {
    const wrappedClasses = new Set(
      workers.flatMap((worker) =>
        exportedWorkerEntrypoints(worker.source).filter((className) =>
          classFetchIsWrapped(worker.source, className),
        ),
      ),
    );
    const referenced = new Set(workers.flatMap((worker) => worker.referencedEntrypoints));
    expect(referenced.size).toBeGreaterThan(0);
    for (const entrypoint of referenced) {
      expect(
        wrappedClasses.has(entrypoint),
        `configured entrypoint ${entrypoint} is unwrapped`,
      ).toBe(true);
    }
  });

  it("fails a synthetic unwrapped Worker the name-contains check would miss", () => {
    const unwrapped = `
      import { ${WRAPPER} } from "@splitch/observability/worker";
      export default {
        fetch() {
          return new Response("ok");
        },
      };
    `;
    expect(unwrapped.includes(WRAPPER)).toBe(true);
    expect(defaultExportIsWrapped(unwrapped)).toBe(false);
  });
});

function discoverHostedWorkers(root: string): HostedWorker[] {
  const workers: HostedWorker[] = [];
  for (const configPath of listWranglerConfigs(root)) {
    const rel = relative(root, configPath);
    if (NON_HOSTED_WRANGLER.has(rel)) continue;
    const config = readWranglerConfig(configPath);
    if (!config.main) continue;
    const mainPath = join(dirname(configPath), config.main);
    workers.push({
      configPath,
      name: config.name ?? rel,
      mainPath,
      source: readFileSync(mainPath, "utf8"),
      referencedEntrypoints: collectReferencedEntrypoints(config),
    });
  }
  return workers;
}

const WRANGLER_WALK_SKIP = new Set([
  "node_modules",
  "dist",
  ".git",
  ".turbo",
  "coverage",
  ".wrangler",
  ".output",
]);

function listWranglerConfigs(root: string): string[] {
  return walkWranglerConfigs(root).sort();
}

function walkWranglerConfigs(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!WRANGLER_WALK_SKIP.has(entry.name)) found.push(...walkWranglerConfigs(path));
      continue;
    }
    if (entry.name === "wrangler.jsonc") found.push(path);
  }
  return found;
}

function readWranglerConfig(path: string): WranglerConfig {
  const parsed = parseConfigFileTextToJson(path, readFileSync(path, "utf8"));
  if (parsed.error) {
    throw new Error(parsed.error.messageText.toString());
  }
  return parsed.config as WranglerConfig;
}

function collectReferencedEntrypoints(config: WranglerConfig): string[] {
  const names = new Set(entrypointNames(config.services));
  for (const target of Object.values(config.env ?? {})) {
    for (const name of entrypointNames(target?.services)) names.add(name);
  }
  return [...names];
}

function entrypointNames(services: Array<{ entrypoint?: string }> | undefined): string[] {
  return (services ?? []).flatMap((service) => (service.entrypoint ? [service.entrypoint] : []));
}

function defaultExportIsWrapped(source: string): boolean {
  if (/\bexport\s+default\s+wrapWorkerHandler\s*\(/.test(source)) return true;
  const ident = source.match(/\bexport\s+default\s+([A-Za-z_$][\w$]*)\s*;/);
  return ident?.[1] ? identifierResolvesToWrap(source, ident[1]) : false;
}

function exportedWorkerEntrypoints(source: string): string[] {
  return [
    ...source.matchAll(/\bexport\s+class\s+([A-Za-z_$][\w$]*)\s+extends\s+WorkerEntrypoint\b/g),
  ].map((match) => match[1] as string);
}

function classFetchIsWrapped(source: string, className: string): boolean {
  const classBody = extractClassBody(source, className);
  if (!classBody) return false;
  const fetchBody = extractFetchMethodBody(classBody);
  if (!fetchBody) return false;
  const callee = fetchBody.match(/\b(?:return\s+(?:await\s+)?)?([A-Za-z_$][\w$]*)\.fetch\s*\(/);
  return callee?.[1] ? identifierResolvesToWrap(source, callee[1]) : false;
}

function identifierResolvesToWrap(source: string, name: string): boolean {
  if (name === WRAPPER) return true;
  const assigned = source.match(
    new RegExp(`\\b(?:const|let|var)\\s+${escapeRegExp(name)}\\s*=\\s*([A-Za-z_$][\\w$]*)`),
  );
  if (assigned?.[1] === WRAPPER) return true;
  if (assigned?.[1]) return functionReturnsWrap(source, assigned[1]);
  return functionReturnsWrap(source, name);
}

function functionReturnsWrap(source: string, name: string): boolean {
  const start = source.search(new RegExp(`\\bfunction\\s+${escapeRegExp(name)}\\s*\\(`));
  if (start === -1) return false;
  const bodyStart = source.indexOf("{", start);
  if (bodyStart === -1) return false;
  const body = sliceBalanced(source, bodyStart);
  return body.includes(`return ${WRAPPER}(`);
}

function extractClassBody(source: string, className: string): string | undefined {
  const start = source.search(new RegExp(`\\bclass\\s+${escapeRegExp(className)}\\b`));
  if (start === -1) return undefined;
  const bodyStart = source.indexOf("{", start);
  if (bodyStart === -1) return undefined;
  return sliceBalanced(source, bodyStart);
}

function extractFetchMethodBody(classBody: string): string | undefined {
  const start = classBody.search(/\bfetch\s*\(/);
  if (start === -1) return undefined;
  const bodyStart = classBody.indexOf("{", start);
  if (bodyStart === -1) return undefined;
  return sliceBalanced(classBody, bodyStart);
}

function sliceBalanced(source: string, openIndex: number): string {
  let depth = 0;
  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(openIndex, index + 1);
    }
  }
  return source.slice(openIndex);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
