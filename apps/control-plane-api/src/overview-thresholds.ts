/**
 * Every tunable the App Overview classifies against, in one place.
 *
 * These are deliberately conservative first values, not tuned ones. Tuning is
 * deferred (SPL-109 ships the surface, not the calibration); when it happens it
 * happens here, and no other module gets to hold a competing number.
 */

/**
 * Share of enrolled entities seen in more than one Variant before the Run is
 * called out as quarantined. Held low because a nonzero multiple-assignment rate
 * already means the assignment contract leaked; 1% is a floor for noise, not an
 * acceptable budget.
 */
export const MULTIPLE_ASSIGNMENT_RATE_THRESHOLD = 0.01;

/** How far back "recently changed" Flag Configuration looks. */
export const FLAG_CHANGE_WINDOW_DAYS = 7;

/**
 * Most recently-changed Flag Configurations SHOWN; the card is a pointer, not a
 * log, so this stays small on purpose.
 *
 * Being small it gets hit routinely, which is why the count of what actually
 * changed travels with the list rather than being discarded by the slice.
 * Raising the number would hide that rather than fix it: at any cap, a card that
 * renders its head as though it were the whole set is the disguised-complete-
 * result ADR-0036 forbids.
 */
export const FLAG_CHANGE_LIMIT = 5;

/**
 * Hard ceiling on Flag Configuration rows the Overview scans for the
 * recently-changed card. Held at the `SESSION_ORG_LIMIT` value for the same
 * reason: a per-request read whose cost tracks how much data a tenant has
 * accumulated is a self-inflicted denial of service, and 50 rows is already far
 * more than any single screen can act on.
 *
 * Deliberately well ABOVE `FLAG_CHANGE_LIMIT`, not equal to it. This bounds READ
 * COST, and hitting it is a real statement — more Flag Configurations changed in
 * this Environment in the window than the Overview will look at. Collapsing the
 * two constants would make the read bound fire on ordinary Environments and turn
 * the truncation notice into noise; how the card presents its own display cap is
 * a separate question with its own ticket.
 */
export const FLAG_CHANGE_READ_LIMIT = 50;

/** Concurrent Analysis reads for one Overview request. */
export const OVERVIEW_ANALYSIS_READ_CONCURRENCY = 8;

/**
 * Hard ceiling on Analysis reads for one Overview. This is a single Environment,
 * so it sits well under the App-wide rollup budget. Past it the Experiment
 * section reports itself unavailable and non-retryable rather than being
 * truncated, because a truncated attention list renders as "nothing to do".
 */
export const OVERVIEW_ANALYSIS_READ_LIMIT = 50;
