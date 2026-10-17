/**
 * Versions recorded in load_manifest. Bump the matching entry when its rules
 * change; the SQL digest in the data version catches a forgotten bump, the
 * names make the change readable in receipts.
 */
export const VERSIONS = {
  /** Download, verification and execution order (src/load.ts). */
  loader: "1.0.0",
  /** Field rules of sql/05_read.sql, 10_bgl.sql, 11_openstack.sql. */
  parser: "1.0.0",
  /** Masks of sql/20_patterns.sql, final after the U03 pattern checks. */
  patternRules: "1.0.0",
  /** sql/30_ownership.sql, final after U03 profiling. */
  ownership: "1.0.0",
  /**
   * Domain rules applied at load time (R-01 api_access, R-02 is_error) and
   * the thresholds they were profiled with (R-05 30 min, R-08 breadth).
   */
  rules: "concept-3.5",
} as const
