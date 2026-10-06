import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DAY_MS = 86_400_000;
// Whole-day shifts keep every time of day, toDate() bucket, and fixed-width
// timestamp ordering intact, so only the YYYY-MM-DD part of a literal changes.
const DATE_LITERAL = /(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/g;
const DAY_TTL = /^ENGINE_TTL "toDateTime\((\w+)\) \+ toIntervalDay\((\d+)\)"$/m;
// A fixture row has to survive the whole build and test run, not just its insert.
const TTL_MARGIN_DAYS = 2;

/**
 * Production ENGINE_TTLs drop fixture rows once their fixed dates age out, so
 * local validation runs against a staged copy of the project in which every
 * fixture and test date moves by the same whole number of days: the newest
 * fixture day becomes yesterday (UTC). The TTLs themselves stay untouched.
 */
export function stageTinybirdProject({ configPath, root, now }) {
  const offsetDays = fixtureOffsetDays(join(root, "fixtures"), now);
  assertFixturesOutliveTtl(root, offsetDays, now);
  const dir = mkdtempSync(join(tmpdir(), "splitch-tinybird-local-"));
  try {
    const stagedRoot = join(dir, root);
    cpSync(configPath, join(dir, configPath));
    cpSync(root, stagedRoot, { recursive: true });
    for (const folder of ["fixtures", "tests"]) {
      for (const file of readdirSync(join(stagedRoot, folder))) {
        const path = join(stagedRoot, folder, file);
        writeFileSync(path, shiftDates(readFileSync(path, "utf8"), offsetDays));
      }
    }
    return { dir, offsetDays, shiftMs: (ms) => ms + offsetDays * DAY_MS };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

export function shiftDates(text, offsetDays) {
  return text.replace(DATE_LITERAL, (literal) => {
    const ms = Date.parse(`${literal}T00:00:00Z`);
    if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== literal) {
      throw new Error(`fixture clock: ${literal} is not a calendar date`);
    }
    return new Date(ms + offsetDays * DAY_MS).toISOString().slice(0, 10);
  });
}

function fixtureOffsetDays(fixturesDir, now) {
  const dates = readdirSync(fixturesDir).flatMap((file) =>
    [...readFileSync(join(fixturesDir, file), "utf8").matchAll(DATE_LITERAL)].map((m) => m[0]),
  );
  if (dates.length === 0) {
    throw new Error(`fixture clock: no dates found in ${fixturesDir}`);
  }
  const newest = Date.parse(`${dates.sort().at(-1)}T00:00:00Z`);
  const yesterday = Math.floor(now / DAY_MS) * DAY_MS - DAY_MS;
  return (yesterday - newest) / DAY_MS;
}

function assertFixturesOutliveTtl(root, offsetDays, now) {
  for (const file of readdirSync(join(root, "datasources"))) {
    const ttl = dayTtl(file, readFileSync(join(root, "datasources", file), "utf8"));
    if (!ttl) {
      continue;
    }
    const fixture = join(root, "fixtures", file.replace(/\.datasource$/, ".ndjson"));
    const expiresBy = now - (ttl.days - TTL_MARGIN_DAYS) * DAY_MS;
    for (const line of readFixtureLines(fixture)) {
      const value = String(JSON.parse(line)[ttl.column]);
      const at = Date.parse(`${value.slice(0, 10)}T${value.slice(11, 19)}Z`);
      if (Number.isNaN(at) || at + offsetDays * DAY_MS < expiresBy) {
        throw new Error(
          `fixture clock: ${fixture} row ${ttl.column}=${value} does not outlive its ${ttl.days}-day ENGINE_TTL; move it closer to the newest fixture date`,
        );
      }
    }
  }
}

function dayTtl(file, contents) {
  if (!contents.includes("ENGINE_TTL")) {
    return null;
  }
  const match = DAY_TTL.exec(contents);
  if (!match) {
    throw new Error(`fixture clock: unrecognized ENGINE_TTL in ${file}`);
  }
  return { column: match[1], days: Number(match[2]) };
}

// A TTL'd datasource fed only by a materialization has no fixture of its own.
function readFixtureLines(path) {
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : [];
}
