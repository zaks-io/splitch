import { readdirSync } from "node:fs";
import { join } from "node:path";

export function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (
        /^(node_modules|dist|build|coverage|test-support|tests?|__tests__|__fixtures__|fixtures|\.\w+)$/.test(
          entry.name,
        )
      )
        return [];
      return sourceFiles(path);
    }
    return /\.[cm]?[jt]sx?$/.test(path) &&
      !/(?:[.-](?:test|spec|fixture|test-fixture)|\.d)\.[cm]?[jt]sx?$/.test(path)
      ? [path]
      : [];
  });
}
