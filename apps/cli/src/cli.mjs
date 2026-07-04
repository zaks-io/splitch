#!/usr/bin/env node
import "tsx/esm";

const { runCli } = await import("./cli");

runCli().then((code) => {
  process.exitCode = code;
});
