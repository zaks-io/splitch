#!/usr/bin/env node
import { rmSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  assertPackedTarball,
  createStagingDirectory,
  pack,
  packageRoot,
  tarballName,
} from "./pack-staging.mjs";

const destination = resolve(process.argv[2] ?? packageRoot);
const staging = createStagingDirectory();
try {
  const name = tarballName(pack(staging, destination));
  assertPackedTarball(join(destination, name));
  console.log(name);
} finally {
  rmSync(staging, { recursive: true, force: true });
}
