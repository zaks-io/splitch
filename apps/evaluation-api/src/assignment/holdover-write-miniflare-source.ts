import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));

export function readSource(name: string): string {
  return readFileSync(join(root, name), "utf8");
}

export function stripImport(source: string, from: string): string {
  return source.replace(
    new RegExp(`^import[\\s\\S]*?from ["']${escapeRegExp(from)}["'];?\\s*`, "m"),
    "",
  );
}

export function stripImports(source: string, froms: string[]): string {
  let next = source;
  for (const from of froms) next = stripImport(next, from);
  return next;
}

export function stripIsRecordHelpers(source: string): string {
  return source.replace(
    /\nfunction isRecord\(value: unknown\): value is Record<string, unknown> \{[\s\S]*?\n\}\n\nfunction requireString\(value: Record<string, unknown>, key: string\): string \{[\s\S]*?\n\}\n/,
    "\n",
  );
}

export function stripExport(source: string): string {
  // Drop re-exports entirely. A dangling `from "…"` becomes a runtime lookup
  // when these sources are concatenated into the Miniflare worker.
  return source
    .replace(/^export\s+type\s+\{[\s\S]*?\}\s+from\s+["'][^"']+["'];?\s*/gm, "")
    .replace(/^export\s+\{[\s\S]*?\}\s+from\s+["'][^"']+["'];?\s*/gm, "")
    .replace(/^export\s+type\s+\{[\s\S]*?\};?\s*/gm, "")
    .replace(/^export\s+\{[\s\S]*?\};?\s*/gm, "")
    .replace(/^export /gm, "");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
