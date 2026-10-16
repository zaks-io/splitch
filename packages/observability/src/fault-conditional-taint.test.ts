import ts from "typescript";
import { describe, expect, it } from "vitest";
import { reportedFaultRethrows } from "./test-support/fault-runtime-wiring";

function parse(code: string): ts.SourceFile {
  return ts.createSourceFile("fixture.ts", code, ts.ScriptTarget.Latest, true);
}

const handlers = [
  ["catch block", (body: string) => `try {} catch (err) { ${body} }`],
  ["catch callback", (body: string) => `task.catch(err => { ${body} })`],
  ["then rejection callback", (body: string) => `task.then(undefined, err => { ${body} })`],
] as const;

const failures = [
  ["direct throw", (value: string) => `reportFault(err); throw new Error(${value});`],
  [
    "aliased throw",
    (value: string) => `const code = ${value}; reportFault(err); throw new Error(code);`,
  ],
  [
    "aliased rejection",
    (value: string) =>
      `const code = ${value}; reportFault(err); return Promise.reject(new Error(code));`,
  ],
] as const;

describe.each(handlers)("conditional taint in %s", (_handler, wrap) => {
  it.each(failures)("allows fixed conditional branches: %s", (_failure, fail) => {
    const value = 'err instanceof TypeError ? "worker_type_failed" : "worker_failed"';
    expect(reportedFaultRethrows(parse(wrap(fail(value))))).toEqual([]);
  });

  it.each([
    ["message in true branch", 'err.message : "worker_failed"'],
    ["message in false branch", '"worker_type_failed" : err.message'],
    ["String in true branch", 'String(err) : "worker_failed"'],
    ["String in false branch", '"worker_type_failed" : String(err)'],
  ])("rejects conditional value taint: %s", (_branch, branches) => {
    const value = `err instanceof TypeError ? ${branches}`;
    for (const [_failure, fail] of failures)
      expect(reportedFaultRethrows(parse(wrap(fail(value))))).toEqual([1]);
  });
});
