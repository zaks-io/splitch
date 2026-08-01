#!/usr/bin/env node
// The pack/publish lifecycle never rebuilds: dist is written once by the
// package build (which stamps it) and everything downstream only reads it.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyBuildStamp } from "../../../scripts/release/build-stamp.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
verifyBuildStamp("sdk", repoRoot);
