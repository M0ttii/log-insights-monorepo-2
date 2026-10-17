-- Full-text index (technical.md § 7, gate G4), created only after log_events
-- is complete.
--
-- Analyzer (SereneDB 26.10.1 pipeline syntax, technical.md § 5.2 point 4):
-- split_text_icu cuts at ICU word boundaries of en_US, as the former
-- `template = 'text', locale = 'en_US.UTF-8'` did, so nova.compute.manager,
-- 0x00544eb8 and c:j12 stay one token and R02-M1-N0 splits into r02, m1,
-- n0; normalize_tokens then applies NFC and lower case. No stemming and no
-- stop words, so log tokens match verbatim apart from case. On every line
-- of BGL and OpenStack the tokens equal those of the 26.09.1.3 dictionary
-- (gate G4). frequency and norm feed BM25 length normalisation, position
-- answers phrases from the index. Queries are analyzed by the same
-- dictionary (search_logs tokenizes with ts_lexize('log_text', …)).
--
-- Replacing log_events already dropped the old index (gate G3). A dictionary
-- cannot be dropped while an index uses it, and CREATE OR REPLACE is not
-- verified for dictionaries, hence DROP INDEX, DROP, CREATE.
DROP INDEX IF EXISTS log_events_idx;
DROP TEXT SEARCH DICTIONARY IF EXISTS log_text;
CREATE TEXT SEARCH DICTIONARY log_text AS
  split_text_icu('en_US.UTF-8')
  | normalize_tokens('en_US.UTF-8', case := 'lower')
  WITH (frequency, position, norm);

-- Filter columns are indexed verbatim (equality and IN run inside the index).
-- ts and event_id are deliberately not indexed: range filters inside the
-- index over-counted on 26.09.1.3 (gate G4); outside it they run as an exact
-- Column Filter on the index scan. Adding them back needs its own
-- correctness evidence, not only a passing gate. Searches read FROM
-- log_events_idx.
CREATE INDEX log_events_idx ON log_events USING inverted (
  dataset, source_file, component, level, source_type, node, rack, midplane,
  alert_label, request_id, instance_id, endpoint, pattern_id,
  message log_text)
WITH (optimize_top_k = 'bm25(1.2, 0.75)');

-- Makes the postings visible now instead of after the background refresh.
VACUUM (REFRESH_TABLE) log_events;
