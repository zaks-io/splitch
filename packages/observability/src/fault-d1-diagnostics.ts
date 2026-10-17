// Static phrases from https://developers.cloudflare.com/d1/observability/debug-d1/
// and SPLITCH-1J event afe9ebc0622d4bf4acbe789e6f08f642 ("internal error").
// Constraint phrases and primary result-code names: https://sqlite.org/rescode.html
const D1_PHRASES = [
  "No SQL statements detected",
  "Your account has exceeded D1's maximum account storage limit",
  "Exceeded maximum DB size",
  "Your account has exceeded D1's free tier daily row read limit",
  "Your account has exceeded D1's free tier daily row write limit",
  "D1 DB reset because its code was updated",
  "Internal error while starting up D1 DB storage caused object to be reset",
  "Network connection lost",
  "Replica disconnected from primary",
  "Internal error in D1 DB storage caused object to be reset",
  "Cannot resolve D1 DB due to transient issue on remote node",
  "Can't read from request stream because client disconnected",
  "storage operation exceeded timeout",
  "D1 DB is overloaded",
  "Requests queued for too long",
  "Too many requests queued",
  "D1 DB's isolate exceeded its memory limit and was reset",
  "D1 DB exceeded its CPU time limit and was reset",
  "Durable Object reset because its code was updated",
  "UNIQUE constraint failed",
  "FOREIGN KEY constraint failed",
  "NOT NULL constraint failed",
  "CHECK constraint failed",
  "internal error",
];

const SQLITE_PRIMARY_CODES = [
  "SQLITE_OK",
  "SQLITE_ERROR",
  "SQLITE_INTERNAL",
  "SQLITE_PERM",
  "SQLITE_ABORT",
  "SQLITE_BUSY",
  "SQLITE_LOCKED",
  "SQLITE_NOMEM",
  "SQLITE_READONLY",
  "SQLITE_INTERRUPT",
  "SQLITE_IOERR",
  "SQLITE_CORRUPT",
  "SQLITE_NOTFOUND",
  "SQLITE_FULL",
  "SQLITE_CANTOPEN",
  "SQLITE_PROTOCOL",
  "SQLITE_EMPTY",
  "SQLITE_SCHEMA",
  "SQLITE_TOOBIG",
  "SQLITE_CONSTRAINT",
  "SQLITE_MISMATCH",
  "SQLITE_MISUSE",
  "SQLITE_NOLFS",
  "SQLITE_AUTH",
  "SQLITE_FORMAT",
  "SQLITE_RANGE",
  "SQLITE_NOTADB",
  "SQLITE_NOTICE",
  "SQLITE_WARNING",
  "SQLITE_ROW",
  "SQLITE_DONE",
];

export function d1Diagnostic(message: string): string | undefined {
  const token = /^D1_[A-Z_]+/.exec(message)?.[0];
  if (!token) return undefined;
  return [
    token,
    ...SQLITE_PRIMARY_CODES.filter((code) => message.includes(code)),
    ...D1_PHRASES.filter((phrase) => message.includes(phrase)),
  ].join(": ");
}
