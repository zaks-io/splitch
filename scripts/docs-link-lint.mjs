#!/usr/bin/env node

import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const origin = "https://splitch.dev";
const publishedUrlPattern = /https:\/\/splitch\.dev(?:\/[^\\\s<>"'`()\]]*)?/g;
const routePattern = /createFileRoute\(\s*["'`]([^"'`]+)["'`]\s*\)/;
const staticIdPattern = /\bid\s*=\s*(?:["']([^"']+)["']|\{\s*["']([^"']+)["']\s*\})/g;
const relativeImportPattern = /\b(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?["'](\.[^"']+)["']/g;

function normalizePathname(value) {
  if (value === "/") return value;
  return value.replace(/\/+$/, "");
}

function routeMatches(route, pathname) {
  const routeSegments = normalizePathname(route).split("/");
  const pathSegments = normalizePathname(pathname).split("/");
  return (
    routeSegments.length === pathSegments.length &&
    routeSegments.every(
      (segment, index) => segment.startsWith("$") || segment === pathSegments[index],
    )
  );
}

function lineForIndex(text, index) {
  return text.slice(0, index).split("\n").length;
}

async function listSourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) return listSourceFiles(entryPath);
      return entry.isFile() && /\.(?:ts|tsx)$/.test(entry.name) ? [entryPath] : [];
    }),
  );
  return nested.flat();
}

async function resolveRelativeModule(importer, specifier) {
  const base = path.resolve(path.dirname(importer), specifier);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, "index.ts"),
    path.join(base, "index.tsx"),
  ];
  for (const candidate of candidates) {
    try {
      await readFile(candidate, "utf8");
      return candidate;
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "EISDIR") throw error;
    }
  }
  return undefined;
}

async function collectStaticIds(entryFile, visited = new Set()) {
  if (visited.has(entryFile)) return new Set();
  visited.add(entryFile);

  const source = await readFile(entryFile, "utf8");
  const ids = new Set();
  for (const match of source.matchAll(staticIdPattern)) ids.add(match[1] ?? match[2]);

  const imports = [];
  for (const match of source.matchAll(relativeImportPattern)) {
    const imported = await resolveRelativeModule(entryFile, match[1]);
    if (imported) imports.push(collectStaticIds(imported, visited));
  }
  for (const importedIds of await Promise.all(imports)) {
    for (const id of importedIds) ids.add(id);
  }
  return ids;
}

export async function buildRouteInventory(routesDirectory) {
  const files = await listSourceFiles(routesDirectory);
  const entries = [];
  for (const filePath of files) {
    const source = await readFile(filePath, "utf8");
    const match = routePattern.exec(source);
    if (!match) continue;
    entries.push({
      route: normalizePathname(match[1]),
      anchors: await collectStaticIds(filePath),
    });
  }
  if (entries.length === 0) throw new Error(`No marketing routes found in ${routesDirectory}`);
  return entries;
}

function routeForPath(inventory, pathname) {
  return inventory
    .filter((entry) => routeMatches(entry.route, pathname))
    .sort((left, right) => Number(left.route.includes("$")) - Number(right.route.includes("$")))[0];
}

function hasStaticRoute(inventory, pathname) {
  const normalized = normalizePathname(pathname);
  return inventory.some((entry) => !entry.route.includes("$") && entry.route === normalized);
}

function parsePublishedUrl(literal) {
  const trimmed = literal.replace(/[.,;:]+$/, "");
  try {
    return new URL(trimmed);
  } catch {
    return undefined;
  }
}

export function lintPublishedDocsText(filePath, text, inventory) {
  const violations = [];
  for (const match of text.matchAll(publishedUrlPattern)) {
    const url = parsePublishedUrl(match[0]);
    const at = { filePath, line: lineForIndex(text, match.index ?? 0) };
    const violation = url
      ? violationForPublishedUrl(url, inventory)
      : `${match[0]} is not a valid URL.`;
    if (violation) violations.push({ ...at, message: violation });
  }
  return violations;
}

function violationForPublishedUrl(url, inventory) {
  const pathname = normalizePathname(decodeURIComponent(url.pathname));
  const route = routeForPath(inventory, pathname);
  if (!route) return `${url.href} names no marketing route.`;
  if (pathname.endsWith(".md") && !routeForPath(inventory, pathname.slice(0, -3))) {
    return `${url.href} has no HTML twin.`;
  }

  const anchor = decodeURIComponent(url.hash.slice(1));
  if (!anchor) return undefined;
  const routedAlternative = `${pathname === "/" ? "" : pathname}/${anchor}`;
  if (hasStaticRoute(inventory, routedAlternative)) {
    return `${url.href} is stale; ${origin}${routedAlternative} is a route, not a section link.`;
  }
  if (!route.anchors.has(anchor)) return `${url.href} names no section anchor on ${pathname}.`;
  return undefined;
}

async function trackedFiles(root) {
  const { stdout } = await execFileAsync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout.split("\0").filter(Boolean);
}

export async function lintTrackedFiles(root, inventory) {
  const files = await trackedFiles(root);
  const groups = await Promise.all(
    files.map(async (filePath) => {
      try {
        const text = await readFile(path.join(root, filePath), "utf8");
        if (text.includes("\0")) return [];
        return lintPublishedDocsText(filePath, text, inventory);
      } catch (error) {
        if (error.code === "ENOENT" || error.code === "EISDIR") return [];
        throw error;
      }
    }),
  );
  return groups.flat();
}

async function main() {
  const root = process.cwd();
  const inventory = await buildRouteInventory(
    path.join(root, "apps", "marketing", "src", "routes"),
  );
  const violations = await lintTrackedFiles(root, inventory);
  if (violations.length === 0) {
    console.log("docs:lint passed");
    return;
  }

  console.error("docs:lint failed");
  for (const violation of violations) {
    console.error(`${violation.filePath}:${violation.line} ${violation.message}`);
  }
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
