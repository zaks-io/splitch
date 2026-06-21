import { existsSync } from "node:fs";

if (!existsSync("tinybird")) {
  console.log("tinybird:local: skipped. Tinybird project files do not exist yet.");
  process.exit(0);
}

console.log(
  "tinybird:local: project directory found; wire tb --local build/test in the analytics slice.",
);
