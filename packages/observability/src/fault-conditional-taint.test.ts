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

describe.each(handlers)("operator value taint in %s", (_handler, wrap) => {
  it.each([
    ["AND OR fixed code", '(err instanceof TypeError && "worker_type_failed") || "worker_failed"'],
    ["AND fixed result", 'err instanceof X && "a"'],
    ["negated predicate", '!err ? "a" : "b"'],
    ["typeof predicate", 'typeof err === "string" ? "a" : "b"'],
    ["nested AND OR true branch", 'flag ? ((err instanceof X && "a") || "b") : "c"'],
    ["nested AND OR false branch", 'flag ? "c" : ((err instanceof X && "a") || "b")'],
    ["AND raw left fixed result", 'err.message && "a"'],
    ["OR fixed conditional", '(err instanceof X ? "" : "a") || "b"'],
    ["nullish fixed conditional", '(err instanceof X ? undefined : "a") ?? "b"'],
    ["instanceof result", "err instanceof X"],
    ["in result", '"key" in err'],
    ["strict equality result", "err === value"],
    ["strict inequality result", "err !== value"],
    ["equality result", "err == value"],
    ["inequality result", "err != value"],
    ["less than result", "err < value"],
    ["less than or equal result", "err <= value"],
    ["greater than result", "err > value"],
    ["greater than or equal result", "err >= value"],
    ["negation result", "!err"],
    ["typeof result", "typeof err"],
  ])("allows fixed operator output: %s", (_pattern, value) => {
    for (const [_failure, fail] of failures)
      expect(reportedFaultRethrows(parse(wrap(fail(value))))).toEqual([]);
  });

  it.each([
    ["OR raw left", 'err.message || "fallback"'],
    ["AND raw right", '"x" && err.message'],
    ["nullish raw left", 'err.message ?? "x"'],
    ["nested AND OR raw", '(cond && err.message) || "y"'],
    ["nested ternary String", 'cond ? "x" : (other ? String(err) : "y")'],
    ["OR raw right", '"" || err.message'],
    ["nullish raw right", "value ?? String(err)"],
    ["AND nested raw", 'cond && (other ? err.message : "x")'],
  ])("rejects data-bearing operator output: %s", (_pattern, value) => {
    for (const [_failure, fail] of failures)
      expect(reportedFaultRethrows(parse(wrap(fail(value))))).toEqual([1]);
  });
});

describe.each(handlers)("discarded operand taint in %s", (_handler, wrap) => {
  it.each([
    ["comma discards raw left", '(err, "worker_failed")'],
    ["void discards raw operand", "void err"],
    ["delete discards raw operand", "delete err.message"],
    ["assignment ignores raw target", 'err = "worker_failed"'],
    ["AND assignment ignores raw left", 'err &&= "worker_failed"'],
    ["OR assignment fixed operands", '({ code: "" }.code ||= "worker_failed")'],
    ["nullish assignment fixed operands", '({ code: undefined }.code ??= "worker_failed")'],
  ])("allows discarded input: %s", (_pattern, value) => {
    for (const [_failure, fail] of failures)
      expect(reportedFaultRethrows(parse(wrap(fail(value))))).toEqual([]);
  });

  it.each([
    ["comma emits raw right", '("worker_failed", err.message)'],
    ["void result then raw comma value", "(void err, err.message)"],
    ["delete result then raw comma value", "(delete err.message, String(err))"],
    ["assignment emits raw right", "value = err.message"],
    ["AND assignment emits raw right", "value &&= err.message"],
    ["OR assignment emits raw left", 'err ||= "worker_failed"'],
    ["OR assignment emits raw right", "value ||= err.message"],
    ["nullish assignment emits raw left", 'err ??= "worker_failed"'],
    ["nullish assignment emits raw right", "value ??= err.message"],
  ])("rejects emitted input: %s", (_pattern, value) => {
    for (const [_failure, fail] of failures)
      expect(reportedFaultRethrows(parse(wrap(fail(value))))).toEqual([1]);
  });

  it.each(["+=", "-=", "*=", "**=", "/=", "%=", "<<=", ">>=", ">>>=", "&=", "|=", "^="])(
    "tracks both compound assignment operands: %s",
    (operator) => {
      for (const [_failure, fail] of failures) {
        expect(
          reportedFaultRethrows(parse(wrap(fail(`String(({ code: 1 }.code ${operator} 1))`)))),
        ).toEqual([]);
        for (const value of [`err ${operator} 1`, `value ${operator} err.message`])
          expect(reportedFaultRethrows(parse(wrap(fail(value))))).toEqual([1]);
      }
    },
  );

  it.each(["throw next", "return Promise.reject(next)"])(
    "allows report comma fixed Error: %s",
    (sink) => {
      const body = `const next = (reportFault(err), new Error("worker_failed")); ${sink};`;
      expect(reportedFaultRethrows(parse(wrap(body)))).toEqual([]);
    },
  );

  it.each(["throw next", "return Promise.reject(next)"])(
    "rejects report comma raw Error: %s",
    (sink) => {
      const body = `const next = (reportFault(err), new Error(err.message)); ${sink};`;
      expect(reportedFaultRethrows(parse(wrap(body)))).toEqual([1]);
    },
  );
});
