/**
 * Named thresholds from concept.md. Values marked "until U03" are defaults that
 * profiling (U03, LOG-12) confirms or replaces per dataset; changing one bumps
 * CONTRACT_VERSION.
 */

/** R-05: a new episode starts after at least this many minutes without an event. Default until U03. */
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
