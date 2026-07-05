#!/usr/bin/env node
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = resolve(packageRoot, "package.json");
const backupPath = resolve(packageRoot, "package.json.pack-backup");

const mode = process.argv[2];

if (mode === "strip") {
  writeFileSync(backupPath, readFileSync(manifestPath));
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  delete manifest.devDependencies;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  process.exit(0);
}

if (mode === "restore") {
  if (!existsSync(backupPath)) {
    process.exit(0);
  }
  writeFileSync(manifestPath, readFileSync(backupPath));
  unlinkSync(backupPath);
  process.exit(0);
}

throw new Error(`usage: ${process.argv[1]} <strip|restore>`);
