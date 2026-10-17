-- G4: dictionary and inverted index over gate.bgl, with the analyzer of
-- sql/50_index.sql (a unit test keeps both equal). 26.10.1 pipeline syntax:
-- ICU word boundaries of en_US, then NFC and lower case; no stemming, no stop
-- words. frequency and norm feed BM25 length normalisation, position answers
-- phrases from the index.
CREATE TEXT SEARCH DICTIONARY gate.msg_dict AS
  split_text_icu('en_US.UTF-8')
  | normalize_tokens('en_US.UTF-8', case := 'lower')
  WITH (frequency, position, norm);

-- String filter columns without a dictionary are indexed verbatim, so equality
-- and IN run inside the index. Range columns (ts, event_id) are deliberately
-- NOT indexed: range filters inside the index returned too many rows on
-- 26.09.1.3 (G4 re-tests it); outside it they run as an exact column filter
-- on the index scan.
CREATE INDEX bgl_idx ON gate.bgl
  USING inverted (dataset, component, level, node, message gate.msg_dict)
  WITH (optimize_top_k = 'bm25(1.2, 0.75)');

-- Makes the postings visible synchronously instead of waiting for the
-- background refresh (refresh_interval, default 1000 ms).
VACUUM (REFRESH_TABLE) gate.bgl;
