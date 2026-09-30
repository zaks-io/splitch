import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { shiftDates, stageTinybirdProject } from "./lib/tinybird-fixture-clock.mjs";

const DAY_MS = 86_400_000;
const TTL = 'ENGINE_TTL "toDateTime(server_received_at) + toIntervalDay(90)"';

test("shiftDates moves every date encoding by whole days and keeps the time of day", () => {
  const text = [
    '"2026-06-30 12:00:00.000001"',
    "from_ts=2026-07-01%2000%3A00%3A00.000",
    "period_start=2026-07-31+00%3A00%3A00.000",
    '"2026-08-01T00:00:00.000Z"',
  ].join("\n");

  assert.equal(
    shiftDates(text, 200),
    [
      '"2027-01-16 12:00:00.000001"',
      "from_ts=2027-01-17%2000%3A00%3A00.000",
      "period_start=2027-02-16+00%3A00%3A00.000",
      '"2027-02-17T00:00:00.000Z"',
    ].join("\n"),
  );
});

test("shiftDates rejects a literal that is not a calendar date", () => {
  assert.throws(() => shiftDates("2026-02-30", 1), /not a calendar date/);
});

test("the repo fixtures land inside the TTL window for any wall-clock date", () => {
  withCwd(fileURLToPath(new URL("..", import.meta.url)), () => {
    for (const now of [
      Date.parse("2026-09-30T21:00:00Z"),
      Date.parse("2027-04-18T00:00:00Z"),
      Date.parse("2031-01-01T12:00:00Z"),
    ]) {
      const { dir } = stageTinybirdProject({
        configPath: "tinybird.config.json",
        root: "infra/tinybird",
        now,
      });
      for (const name of ["raw_events", "raw_evaluations", "metric_events"]) {
        for (const at of receivedAt(join(dir, "infra/tinybird/fixtures", `${name}.ndjson`))) {
          assert.ok(at < now && at > now - 90 * DAY_MS, `${name} row at ${at} outside TTL`);
        }
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("staging fails loud when a TTL'd fixture row would expire during the run", () => {
  withProject(
    [
      '{"server_received_at":"2026-07-01 00:00:00.000"}',
      '{"server_received_at":"2026-04-01 00:00:00.000"}',
    ],
    TTL,
    (stage) =>
      assert.throws(
        stage,
        /server_received_at=2026-04-01 00:00:00.000 does not outlive its 90-day ENGINE_TTL/,
      ),
  );
});

test("staging fails loud on an ENGINE_TTL it cannot reason about", () => {
  withProject(
    ['{"server_received_at":"2026-07-01 00:00:00.000"}'],
    'ENGINE_TTL "toDateTime(server_received_at) + toIntervalMonth(3)"',
    (stage) => assert.throws(stage, /unrecognized ENGINE_TTL in raw_events.datasource/),
  );
});

function receivedAt(path) {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => Date.parse(`${JSON.parse(line).server_received_at.replace(" ", "T")}Z`));
}

function withCwd(dir, fn) {
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    fn();
  } finally {
    process.chdir(cwd);
  }
}

function withProject(fixtureRows, ttl, fn) {
  const base = mkdtempSync(join(tmpdir(), "fixture-clock-test-"));
  try {
    withCwd(base, () => {
      writeFileSync("config.json", "{}");
      for (const folder of ["datasources", "fixtures", "tests"]) {
        mkdirSync(join("tb", folder), { recursive: true });
      }
      writeFileSync(join("tb", "datasources", "raw_events.datasource"), `${ttl}\n`);
      writeFileSync(join("tb", "fixtures", "raw_events.ndjson"), `${fixtureRows.join("\n")}\n`);
      fn(() => stageTinybirdProject({ configPath: "config.json", root: "tb", now: Date.now() }));
    });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}
