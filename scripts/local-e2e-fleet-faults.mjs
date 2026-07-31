/**
 * SPL-181: the local E2E fleet runs several workerd processes against one
 * `--persist-to` directory. Two of them (control-plane-api and the control-panel
 * Vite dev server) bind the same local D1, so they open the same SQLite file from
 * different OS processes and intermittently lose the write lock. workerd surfaces
 * that as an opaque `internal error` and the affected Worker can die outright,
 * which used to read as an ordinary spec failure. Detect the signature, name it,
 * and let the harness recover instead of mis-attributing the blame.
 */

export const HARNESS_FAULT_LABEL = "SPL-181 harness fault: miniflare D1 crashed";

/**
 * Storage-layer faults only. Deliberately NOT matched: anything a Worker throws on
 * purpose. In particular the panel's read-only D1 refusal says "read-only", so
 * `SQLITE_READONLY` is absent — labelling a real product bug as a harness fault
 * would hide it, which is worse than the phantom failures this exists to stop.
 */
const FAULT_PATTERNS = [
  /SQLITE_(?:BUSY|BUSY_SNAPSHOT|LOCKED|IOERR|CANTOPEN|CORRUPT|PROTOCOL|NOTADB)/,
  /database (?:is|table is) locked/,
  /disk I\/O error/,
  /D1DatabaseObject\./,
  /workerd\/util\/sqlite\.c\+\+/,
  /Error: internal error; reference = [a-z0-9]+/,
];

export function matchFaultSignature(line) {
  const pattern = FAULT_PATTERNS.find((candidate) => candidate.test(line));
  return pattern ? pattern.source : "";
}

export function createFaultTracker({ now = () => Date.now() } = {}) {
  const faults = [];
  const buffers = new Map();

  function record(worker, line) {
    const signature = matchFaultSignature(line);
    if (!signature) return undefined;
    const fault = { worker, signature, line: line.trim(), at: now() };
    faults.push(fault);
    return fault;
  }

  return {
    /**
     * Feed raw stdio through line-buffered matching. Returns every fault the
     * chunk completed, so a caller can react per fault rather than per chunk.
     */
    scan(worker, chunk) {
      const pending = `${buffers.get(worker) ?? ""}${chunk}`;
      const lines = pending.split("\n");
      buffers.set(worker, lines.pop() ?? "");
      return lines.map((line) => record(worker, line)).filter(Boolean);
    },
    /** Flush a trailing partial line, e.g. when a Worker exits mid-write. */
    flush(worker) {
      const remainder = buffers.get(worker) ?? "";
      buffers.set(worker, "");
      return remainder ? [record(worker, remainder)].filter(Boolean) : [];
    },
    list() {
      return faults.map((fault) => ({ ...fault }));
    },
    since(timestamp) {
      return faults.filter((fault) => fault.at >= timestamp).map((fault) => ({ ...fault }));
    },
    get count() {
      return faults.length;
    },
  };
}

export function describeFault(fault) {
  return `${HARNESS_FAULT_LABEL} (${fault.worker}: ${fault.line})`;
}
