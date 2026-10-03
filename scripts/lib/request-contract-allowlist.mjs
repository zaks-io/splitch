const REQUIRED_FIELDS = ["operationId", "path", "releasedTag", "reason"];

/**
 * Validate the reviewed allowlist and split violations into those it excuses
 * and those still failing. Each entry names the released tag it excuses a break
 * against: entries for the current tag that excuse nothing are stale and fail,
 * so the allowlist cannot outlive its skew. Entries written for another tag are
 * returned as expired instead of failing, because cutting a CLI release moves
 * the anchor without a commit and must not turn main red on its own.
 */
export function applyAllowlist(violations, allowlist, releasedTag) {
  const problems = validateAllowlist(allowlist);
  const entries = Array.isArray(allowlist) ? allowlist : [];
  const current = entries.filter((entry) => entry?.releasedTag === releasedTag);
  const keyOf = (item) => `${item.operationId}\u0000${item.path}`;
  const allowed = new Set(current.map(keyOf));
  const matched = new Set(violations.map(keyOf).filter((key) => allowed.has(key)));
  return {
    problems,
    failing: violations.filter((violation) => !allowed.has(keyOf(violation))),
    excused: violations.filter((violation) => allowed.has(keyOf(violation))),
    stale: current.filter((entry) => !matched.has(keyOf(entry))),
    expired: entries.filter((entry) => entry?.releasedTag !== releasedTag),
  };
}

function validateAllowlist(entries) {
  if (!Array.isArray(entries)) return ["allowlist must be a JSON array"];
  const problems = [];
  const seen = new Set();
  entries.forEach((entry, index) => {
    for (const field of REQUIRED_FIELDS) {
      if (typeof entry?.[field] !== "string" || entry[field].trim() === "") {
        problems.push(`entry ${index} needs a non-empty string "${field}"`);
      }
    }
    const key = `${entry?.releasedTag} ${entry?.operationId} ${entry?.path}`;
    if (seen.has(key)) problems.push(`entry ${index} duplicates ${key}`);
    seen.add(key);
  });
  return problems;
}
