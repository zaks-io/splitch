import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function defineTestFileManifest(configUrl: string, files: readonly string[]): string[] {
  if (files.length === 0) throw new Error("test manifest must not be empty");

  const duplicates = files.filter((file, index) => files.indexOf(file) !== index);
  if (duplicates.length > 0) {
    throw new Error(
      `test manifest contains duplicate entries: ${[...new Set(duplicates)].join(", ")}`,
    );
  }

  const missing = files.filter((file) => !existsSync(fileURLToPath(new URL(file, configUrl))));
  if (missing.length > 0) {
    throw new Error(`test manifest contains missing files: ${missing.join(", ")}`);
  }

  return [...files];
}
