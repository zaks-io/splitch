import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sdkNodeMajor } from "./package-facts";

const authoredRoot = join(import.meta.dirname, "..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    if (path.endsWith(".test.ts") || path.endsWith(".test.tsx")) return [];
    return /\.tsx?$/.test(path) ? [path] : [];
  });
}

/**
 * Every version the site states has to come from the manifest or the gate that
 * enforces it. A number typed into prose reads as current forever: the install
 * page carried a pinned SDK version for three minor releases after it stopped
 * being the published one, and nothing failed. Interpolating from
 * `package-facts` keeps these literals out of source, which is what makes this
 * grep a usable guard.
 */
const bannedLiterals = [
  /@splitch\/[a-z-]+@\d/,
  /\bNode \d/,
  /\bWrangler \d/i,
  /\bReact \d\d/,
  /\bConvex \d/,
];

describe("package facts", () => {
  it("reads the Node floor from the manifest", () => {
    expect(sdkNodeMajor).toBeGreaterThanOrEqual(24);
  });

  it("states no version the source hardcodes", () => {
    const offenders = sourceFiles(authoredRoot).flatMap((path) => {
      const text = readFileSync(path, "utf8");
      return bannedLiterals
        .filter((pattern) => pattern.test(text))
        .map((pattern) => `${path}: ${pattern.exec(text)?.[0]}`);
    });
    expect(offenders).toEqual([]);
  });
});
