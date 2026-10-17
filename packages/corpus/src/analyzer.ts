/**
 * Analyzer of the full-text dictionary `log_text` (sql/50_index.sql), in the
 * pipeline syntax of SereneDB 26.10.1: ICU word boundaries of en_US, then NFC
 * and lower case; no stemming, no stop words (technical.md § 5.2, point 4).
 * The gate probes build their dictionaries from it, and a unit test keeps the
 * SQL files and the analytics fixtures on the same text.
 */
export const LOG_TEXT_ANALYZER =
  "split_text_icu('en_US.UTF-8') | normalize_tokens('en_US.UTF-8', case := 'lower')"
