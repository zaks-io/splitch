#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyBuildStamp } from "../../../scripts/release/build-stamp.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
verifyBuildStamp("cloudflare", repoRoot);
