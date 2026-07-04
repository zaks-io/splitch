#!/usr/bin/env node
import "tsx/esm";

const { launchCli } = await import("./cli");

await launchCli();
