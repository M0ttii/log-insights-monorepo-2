/**
 * Named thresholds from concept.md; changing one bumps CONTRACT_VERSION.
 */

/**
 * R-05: a new episode starts after at least this many minutes without an
 * event. Confirmed for both datasets by profiling (U03, LOG-12; concept R-05):
 * BGL gaps of error patterns are sparse between 10 min and 2 h, and every gap
 * between OpenStack error events is at least 30 min.
 */
export const EPISODE_GAP_MINUTES = 30

/** R-05: a pattern with at least this many episodes in the window is "recurring". */
export const RECURRING_MIN_EPISODES = 2

/** R-06: "significantly increased" needs C ≥ factor · B … */
export const SIGNIFICANT_INCREASE_FACTOR = 2

/** … and at least this many additional events. */
export const SIGNIFICANT_INCREASE_MIN_EVENTS = 20

/** R-11: precursor window default and maximum in minutes. */
export const PRECURSOR_WINDOW_DEFAULT_MINUTES = 10
export const PRECURSOR_WINDOW_MAX_MINUTES = 60

/** R-11: below this many anchors the base rate is omitted. */
export const PRECURSOR_MIN_ANCHORS_FOR_BASE_RATE = 5
