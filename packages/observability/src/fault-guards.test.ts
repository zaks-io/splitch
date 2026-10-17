import ts from "typescript";
import { expect, it } from "vitest";
import { unsafeFaultLogs } from "./test-support/fault-log-wiring";
import { reportedFaultRethrows } from "./test-support/fault-runtime-wiring";
import { unsafeStackWrites } from "./test-support/fault-stack-wiring";

function parse(code: string): ts.SourceFile {
  return ts.createSourceFile("fixture.ts", code, ts.ScriptTarget.Latest, true);
}

it.each([
  "task.catch(err => console.error(err))",
  "task.catch(err => logger.error({ err }))",
  "try {} catch (error) { const payload = { err: error }; console.error(payload.err); }",
  "task.then(undefined, rejected => console.error(rejected))",
  "task.then(onSuccess, rejected => logger.error({ err: rejected }))",
  "task.catch(arbitrary => { const p = { err: arbitrary }; console.error(p.err); })",
  'task["catch"](problem => console.error(problem))',
  'task["then"](undefined, problem => console.error(problem))',
  'try {} catch (problem) { const p = { err: problem }; console.error(p["err"]); }',
  "try {} catch (problem) { const p = { detail: { err: problem } }; const alias = p; console.error(alias.detail.err); }",
  "task.catch(function (problem) { console.error(problem); })",
  "function rejected(problem: unknown) { console.error(problem); } task.catch(rejected)",
  "const rejected = problem => console.error(problem); task.then(undefined, rejected)",
  "function report(err: Error) { console.error(err); }",
  "console.error(new Error('private'))",
])("rejects callback and object fault leaks: %s", (code) => {
  expect(unsafeFaultLogs(parse(code))).toHaveLength(1);
});

it.each([
  "task.catch(problem => console.error(serializeFault(problem)))",
  "task.then(undefined, problem => logger.error({ fault: serializeFault(problem) }))",
  "task.catch(problem => { const p = { fault: serializeFault(problem) }; console.error(p.fault); })",
  "task.then(value => console.info(value))",
  "task.then(value => console.info(value), problem => console.error(serializeFault(problem)))",
  "try {} catch (problem) { const p = { requestId: 'id' }; console.error(p.requestId); }",
  "try {} catch (problem) { console.error({ flagId: problem.flagId, fault: serializeFault(problem) }); }",
  "try {} catch (problem) { const p = { err: problem, fault: serializeFault(problem) }; console.error(p.fault); }",
  "function report(name: 'WriteError', cause: unknown) { console.error(name, { cause: serializeFault(cause) }); }",
])("accepts serialized callbacks and ordinary data: %s", (code) => {
  expect(unsafeFaultLogs(parse(code))).toEqual([]);
});

it.each([
  'error.stack = "forged"',
  'error["stack"] = "forged"',
  "error[`stack`] = 'forged'",
  'error.stack += "frame"',
  'error["stack"] ??= "frame"',
  "Error.prepareStackTrace = formatter",
  'Error["prepareStackTrace"] = formatter',
  "Error[`prepareStackTrace`] = formatter",
  "globalThis.Error.prepareStackTrace = formatter",
  'globalThis["Error"]["prepareStackTrace"] = formatter',
  "globalThis['Error']['prepareStackTrace'] = formatter",
])("rejects replacement of trusted engine stacks: %s", (code) => {
  expect(unsafeStackWrites(parse(code))).toEqual([1]);
});

it.each([
  "const stack = error.stack",
  'const stack = error["stack"]',
  "const formatter = Error.prepareStackTrace",
  "error.name = 'Error'",
  "const metadata = { stack: 'label' }",
  "// error.stack = 'forged'\nconst note = 'Error.prepareStackTrace = formatter'",
])("accepts reads and unrelated source: %s", (code) => {
  expect(unsafeStackWrites(parse(code))).toEqual([]);
});

it.each([
  "try {} catch (problem) { reportFault(problem); throw problem; }",
  "try {} catch (problem) { reportCloudflarePushFault(env, ctx, problem, 'mutation'); throw problem; }",
  "try {} catch (problem) { createWorkerFaultReporter(env, options)('failure', { fault: serializeFault(problem) }); throw problem; }",
  "try {} catch (problem) { observability.onError({ cause: problem }); throw problem; }",
  "task.catch(problem => { reportFault(problem); throw problem; })",
  "task.then(undefined, problem => { reportFault(problem); throw problem; })",
  "ctx.waitUntil(task.catch(problem => { reportFault(problem); throw problem; }))",
  "ctx.waitUntil(task.then(onSuccess, problem => { reportFault(problem); throw problem; }))",
  "try {} catch (problem) { const alias = problem; reportFault(problem); throw alias; }",
  "try {} catch (problem) { let alias; alias = problem; reportFault(problem); throw (alias as Error); }",
  "const rejected = problem => { reportFault(problem); throw problem; }; ctx.waitUntil(task.catch(rejected))",
  "function rejected(problem) { reportFault(problem); throw problem; } task.then(undefined, rejected)",
  "const output = createWorkerFaultReporter(env, options); task.catch(problem => { output('failure', { fault: serializeFault(problem) }); throw problem; })",
  "const output = deps.onError; task.then(undefined, problem => { output({ cause: problem }); throw problem; })",
  "import { createWorkerFaultReporter as reporter } from './worker'; const output = reporter(env, options); task.catch(problem => { output('failure'); throw problem; })",
])("rejects report-then-rethrow paths: %s", (code) => {
  expect(reportedFaultRethrows(parse(code))).toEqual([1]);
});

it.each([
  "try {} catch (problem) { throw problem; }",
  "try {} catch (problem) { console.error('failure', { fault: serializeFault(problem) }); throw problem; }",
  "try {} catch (problem) { deps.logger?.warn('schema_mismatch', { cause: serializeFault(problem) }); throw problem; }",
  "try {} catch (problem) { reportFault(problem); return; }",
  "try {} catch (problem) { reportFault(problem); throw new Error('worker_failed'); }",
  "task.catch(problem => { reportFault(problem); })",
  "ctx.waitUntil(task.then(undefined, problem => { reportFault(problem); }))",
  "try {} catch (problem) { if (shouldRethrow) throw problem; reportFault(problem); }",
  "try {} catch (problem) { const later = () => reportFault(problem); throw problem; }",
  "try {} catch (problem) { reportFault(problem); const later = () => { throw problem; }; }",
  "try {} catch (outer) { try {} catch (inner) { reportFault(inner); } throw outer; }",
  "try {} catch (outer) { reportFault(outer); task.catch(inner => { throw inner; }); }",
  "try {} catch (problem) { if (handled) { reportFault(problem); return; } throw problem; }",
  "try {} catch (problem) { function later() { reportFault(problem); } throw problem; }",
  "try {} catch (problem) { const output = createWorkerFaultReporter(env, options); throw problem; }",
  "try {} catch (problem) { const message = 'onError'; throw problem; }",
])("accepts handled faults and unrelated rethrows: %s", (code) => {
  expect(reportedFaultRethrows(parse(code))).toEqual([]);
});

it("reports actionable source lines", () => {
  expect(unsafeStackWrites(parse("const error = new Error();\nerror.stack = 'frame';"))).toEqual([
    2,
  ]);
  expect(
    reportedFaultRethrows(
      parse(`try {} catch (problem) {
    reportFault(problem);
    throw problem;
  }`),
    ),
  ).toEqual([3]);
});
