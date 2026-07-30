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

/** Most recently-changed Flag Configurations shown; the card is a pointer, not a log. */
export const FLAG_CHANGE_LIMIT = 5;

/** Concurrent Analysis reads for one Overview request. */
export const OVERVIEW_ANALYSIS_READ_CONCURRENCY = 8;

/**
 * Hard ceiling on Analysis reads for one Overview. This is a single Environment,
 * so it sits well under the App-wide rollup budget. Past it the Experiment
 * section reports itself unavailable and non-retryable rather than being
 * truncated, because a truncated attention list renders as "nothing to do".
 */
export const OVERVIEW_ANALYSIS_READ_LIMIT = 50;
