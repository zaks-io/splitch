type ReferrerDisclosure = 0 | 1 | 2;
type ReferrerDisclosureMatrix = readonly [
  sameOrigin: ReferrerDisclosure,
  crossOrigin: ReferrerDisclosure,
  downgrade: ReferrerDisclosure,
];

const REFERRER_POLICY_DISCLOSURE: Record<string, ReferrerDisclosureMatrix> = {
  "unsafe-url": [2, 2, 2],
  "no-referrer-when-downgrade": [2, 2, 0],
  "origin-when-cross-origin": [2, 1, 1],
  origin: [1, 1, 1],
  "strict-origin-when-cross-origin": [2, 1, 0],
  "strict-origin": [1, 1, 0],
  "same-origin": [2, 0, 0],
  "no-referrer": [0, 0, 0],
};

/**
 * Browsers use the last recognized Referrer-Policy token. Replace it only when
 * the extra reveals no more for same-origin, cross-origin, and downgrade
 * requests. Incomparable policies keep the route's existing choice.
 */
export function strongerReferrerPolicy(current: string, extra: string): string {
  const currentDisclosure = referrerPolicyDisclosure(current);
  const extraDisclosure = referrerPolicyDisclosure(extra);
  if (!extraDisclosure) return current;
  if (!currentDisclosure) return extra;
  return extraDisclosure.every((value, index) => value <= (currentDisclosure[index] ?? 0))
    ? extra
    : current;
}

function referrerPolicyDisclosure(header: string): ReferrerDisclosureMatrix | undefined {
  const effective = lastRecognizedReferrerPolicy(header);
  return effective === undefined ? undefined : REFERRER_POLICY_DISCLOSURE[effective];
}

function lastRecognizedReferrerPolicy(header: string): string | undefined {
  let recognized: string | undefined;
  for (const token of header.split(",")) {
    const normalized = token.trim().toLowerCase();
    if (normalized in REFERRER_POLICY_DISCLOSURE) recognized = normalized;
  }
  return recognized;
}
