import ts from "typescript";
import { expect, it } from "vitest";
import { unsafeFaultLogs } from "./test-support/fault-log-wiring";
import { reportedFaultRethrows } from "./test-support/fault-runtime-wiring";
import { unsafeStackWrites } from "./test-support/fault-stack-wiring";

function parse(code: string): ts.SourceFile {
  return ts.createSourceFile("fixture.ts", code, ts.ScriptTarget.Latest, true);
}

it.each([
  ["assign stack", "Object.assign(error, { stack: incoming.stack })"],
  ["assign shorthand", "Object.assign(error, { stack })"],
  ["assign spread", "Object.assign(error, { ...{ stack } })"],
  ["assign aliased spread", "const props = { stack }; Object.assign(error, { ...props })"],
  ["defineProperty stack", 'Object.defineProperty(error, "stack", { value: frame })'],
  ["defineProperties stack", "Object.defineProperties(error, { stack: { value: frame } })"],
  ["reflect set stack", 'Reflect.set(error, "stack", frame)'],
  ["reflect define stack", 'Reflect.defineProperty(error, "stack", { value: frame })'],
  ["computed stack", 'error["stack"] = frame'],
  ["assign prepareStackTrace", "Object.assign(Error, { prepareStackTrace: formatter })"],
  ["assign prepare shorthand", "Object.assign(Error, { prepareStackTrace })"],
  ["assign prepare spread", "Object.assign(Error, { ...{ prepareStackTrace } })"],
  [
    "defineProperty prepare",
    'Object.defineProperty(Error, "prepareStackTrace", { value: formatter })',
  ],
  [
    "defineProperties prepare",
    "Object.defineProperties(Error, { prepareStackTrace: { value: formatter } })",
  ],
  ["reflect set prepare", 'Reflect.set(Error, "prepareStackTrace", formatter)'],
  [
    "reflect define prepare",
    'Reflect.defineProperty(Error, "prepareStackTrace", { value: formatter })',
  ],
  ["computed prepare", 'Error["prepareStackTrace"] = formatter'],
])("rejects stack write pattern: %s", (_pattern, code) => {
  expect(unsafeStackWrites(parse(code))).toEqual([1]);
});

it.each([
  ["reject caught", "return Promise.reject(err)"],
  ["throw derived message", "throw new Error(err.message)"],
  ["throw derived String", "throw new Error(String(err))"],
  ["reject derived message", "return Promise.reject(new Error(err.message))"],
  ["reject derived String", "Promise.reject(new Error(String(err)))"],
  ["throw cause option", 'throw new Error("failed", { cause: err })'],
  ["reject cause option", 'return Promise.reject(new Error("failed", { cause: err }))'],
  ["throw cause record", "throw { cause: err }"],
  ["reject cause record", "return Promise.reject({ cause: err })"],
  ["throw cause", "throw err.cause"],
  ["reject cause", "return Promise.reject(err.cause)"],
  ["aliased derived error", "const next = new Error(err.message); throw next"],
  ["aliased cause option", 'const options = { cause: err }; throw new Error("failed", options)'],
])("rejects reported rejection pattern: %s", (_pattern, statement) => {
  for (const code of [
    `try {} catch (err) { reportFault(err); ${statement}; }`,
    `task.catch(err => { reportFault(err); ${statement}; })`,
    `task.then(null, err => { reportFault(err); ${statement}; })`,
  ])
    expect(reportedFaultRethrows(parse(code))).toEqual([1]);
});

it.each([
  ["direct catch console", "task.catch(console.error)"],
  ["direct then undefined console", "task.then(undefined, console.error)"],
  ["direct then null logger", "task.then(null, logger.error)"],
  ["direct aliased logger", "const output = console.error; task.catch(output)"],
  ["direct bound logger", "task.catch(console.error.bind(console))"],
])("rejects raw rejection logger pattern: %s", (_pattern, code) => {
  expect(unsafeFaultLogs(parse(code))).toEqual([1]);
});

it.each([
  ["toString", "err.toString()"],
  ["String", "String(err)"],
  // biome-ignore lint/suspicious/noTemplateCurlyInString: source fixture for interpolation
  ["template", "`failure: ${err}`"],
  ["JSON.stringify", "JSON.stringify(err)"],
  ["message", "err.message"],
  ["stack", "err.stack"],
  ["cause", "err.cause"],
  ["params", "err.params"],
  ["query", "err.query"],
  ["computed params", 'err["params"]'],
])("rejects raw error conversion/property pattern: %s", (_pattern, value) => {
  expect(unsafeFaultLogs(parse(`task.catch(err => console.error(${value}))`))).toEqual([1]);
});

it.each([
  'Object.assign(value, { name: "label" })',
  'Object.defineProperty(value, "name", { value: "label" })',
  'Reflect.set(value, "name", "label")',
  "Object.assign(value, { prepareStackTrace: formatter })",
])("accepts unrelated property writes: %s", (code) => {
  expect(unsafeStackWrites(parse(code))).toEqual([]);
});

it.each([
  'throw new Error("fault_code")',
  "throw new Error(code)",
  'return Promise.reject(new Error("fault_code"))',
  "return Promise.reject(new Error(code))",
])("accepts fresh safe runtime failures: %s", (statement) => {
  expect(
    reportedFaultRethrows(parse(`task.catch(err => { reportFault(err); ${statement}; })`)),
  ).toEqual([]);
});
