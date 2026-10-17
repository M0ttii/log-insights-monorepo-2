-- G4: dictionary and inverted index over gate.bgl.
-- Syntax of image 26.09.1.3 (option list with a template); the web docs show a
-- newer pipeline syntax that this image rejects. Stemming is off so log tokens
-- match verbatim apart from case; frequency and norm feed BM25 length
-- normalisation, position answers phrases from the index.
CREATE TEXT SEARCH DICTIONARY gate.msg_dict (
  template = 'text', locale = 'en_US.UTF-8', case = 'lower',
  stemming = false, frequency, position, norm);

-- String filter columns without a dictionary are indexed verbatim, so equality
-- and IN run inside the index. Range columns (ts, event_id) are deliberately
-- NOT indexed: range filters inside the index return too many rows on this
-- image (G4 reproduces it); outside it they run as an exact column filter on
-- the index scan.
CREATE INDEX bgl_idx ON gate.bgl
  USING inverted (dataset, component, level, node, message gate.msg_dict)
  WITH (optimize_top_k = 'bm25(1.2, 0.75)');

-- Makes the postings visible synchronously instead of waiting for the
-- background refresh (refresh_interval, default 1000 ms).
VACUUM (REFRESH_TABLE) gate.bgl;
