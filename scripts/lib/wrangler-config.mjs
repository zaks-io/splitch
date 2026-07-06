import { readFileSync } from "node:fs";
import { parseConfigFileTextToJson } from "typescript";

export function parseWranglerConfigFile(path) {
  const parsed = parseConfigFileTextToJson(path, readFileSync(path, "utf8"));
  if (parsed.error) {
    throw new Error(`${path}: ${String(parsed.error.messageText)}`);
  }
  return parsed.config;
}
