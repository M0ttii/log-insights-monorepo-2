/**
 * Versions recorded in load_manifest. Bump the matching entry when its rules
 * change; the SQL digest in the data version catches a forgotten bump, the
 * names make the change readable in receipts.
 */
export const VERSIONS = {
  /** Download, verification and execution order (src/load.ts). */
  loader: "1.1.0",
  /**
   * Field rules of sql/05_read.sql and the parsers 10–14; 1.1.0 adds the
   * extension parsers (U26), BGL and OpenStack rules unchanged.
   */
  parser: "1.1.0",
  /**
   * Masks of sql/20_patterns.sql; 1.1.0 adds the extension chain (U26), the
   * base-corpus chain is that of 1.0.0.
   */
  patternRules: "1.1.0",
  /** sql/30_ownership.sql; 1.1.0 adds the extension teams (U26). */
  ownership: "1.1.0",
  /**
   * Domain rules applied at load time (R-01 api_access, R-02 is_error) and
   * the thresholds they were profiled with (R-05 30 min, R-08 breadth).
   */
  rules: "concept-3.8",
} as const
