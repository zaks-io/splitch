#!/usr/bin/env node
import { rmSync } from "node:fs";
import { join } from "node:path";
import {
  assertReleaseTarballContents,
  createPackStagingDir,
  getPackageRoot,
  listTarballFiles,
  packStagingDir,
  parseTarballName,
  readTarballFile,
} from "./pack-staging.mjs";

const packageRoot = getPackageRoot();
const destination = process.argv[2] ? resolveDestination(process.argv[2]) : packageRoot;

const staging = createPackStagingDir(packageRoot);
try {
  const output = packStagingDir(staging, { destination });
  const tarballName = parseTarballName(output);
  const tarballPath = join(destination, tarballName);
  const listing = listTarballFiles(tarballPath);
  const manifestText = readTarballFile(tarballPath, "package/package.json");
  const declarationText = readTarballFile(tarballPath, "package/dist/index.d.ts");
  assertReleaseTarballContents({ listing, manifestText, declarationText });
  process.stdout.write(`${tarballName}\n`);
} finally {
  rmSync(staging, { recursive: true, force: true });
}

function resolveDestination(value) {
  return value.startsWith("/") ? value : join(packageRoot, value);
}
