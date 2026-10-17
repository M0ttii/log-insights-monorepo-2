-- Full-text index (technical.md § 7, gate G4), created only after log_events
-- is complete. Syntax of image 26.09.1.3 (option list with a template; the
-- pipeline syntax on the website is newer). Lower case, no stemming, so log
-- tokens match verbatim apart from case; frequency and norm feed BM25 length
-- normalisation, position answers phrases from the index.
--
-- Replacing log_events already dropped the old index (gate G3). A dictionary
-- cannot be dropped while an index uses it, and CREATE OR REPLACE is not
-- verified for dictionaries, hence DROP INDEX, DROP, CREATE.
DROP INDEX IF EXISTS log_events_idx;
DROP TEXT SEARCH DICTIONARY IF EXISTS log_text;
CREATE TEXT SEARCH DICTIONARY log_text (
  template = 'text', locale = 'en_US.UTF-8', case = 'lower',
  stemming = false, frequency, position, norm);

-- Filter columns are indexed verbatim (equality and IN run inside the index).
-- ts and event_id are deliberately not indexed: range filters inside the
-- index over-count on this image (gate G4); outside it they run as an exact
-- Column Filter on the index scan. Searches read FROM log_events_idx.
CREATE INDEX log_events_idx ON log_events USING inverted (
  dataset, source_file, component, level, source_type, node, rack, midplane,
  alert_label, request_id, instance_id, endpoint, pattern_id,
  message log_text)
WITH (optimize_top_k = 'bm25(1.2, 0.75)');

-- Makes the postings visible now instead of after the background refresh.
VACUUM (REFRESH_TABLE) log_events;
