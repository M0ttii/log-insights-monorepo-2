-- G2: full BGL as one text column per line, then fields per regex.
-- This is a gate probe, not the U02 loader: it checks the SQL constructs and
-- measures load time. Field rules, rejects and R-04 masks belong to U02/U03.

-- Each line is read verbatim: the delimiter is the ASCII unit separator, which
-- the corpus does not contain, and quote/escape are disabled so `"` and `\`
-- stay data. row_number() OVER () follows the reader order, which
-- preserve_insertion_order (default on) guarantees to be the file order.
CREATE OR REPLACE TABLE gate.bgl_raw AS
SELECT row_number() OVER () AS line_no, line
FROM read_csv('{{RAW_DIR}}/BGL.log',
  columns = {'line': 'VARCHAR'}, delim = E'\x1f', quote = '', escape = '',
  header = false, auto_detect = false);

-- regexp_extract returns '' for a missing group, so every field is wrapped in
-- NULLIF to keep absent values NULL. BGL time is the Unix second plus the
-- microseconds of the text timestamp; to_timestamp yields TIMESTAMPTZ.
-- pattern_id is a crude gate-only mask (hex and digits) used for G9 timing.
CREATE OR REPLACE TABLE gate.bgl AS
WITH parsed AS (
  SELECT line_no, line,
    regexp_extract(line,
      '^(\S+) (\d+) (\S+) (\S+) (\d{4}-\d{2}-\d{2}-\d{2}\.\d{2}\.\d{2}\.(\d{6})) (\S+) (\S+) (\S+) (\S+)(?: (.*))?$',
      ['label', 'unix_s', 'date', 'node', 'ts_text', 'micros', 'node2',
       'source_type', 'component', 'level', 'message']) AS f
  FROM gate.bgl_raw)
SELECT
  line_no AS event_id,
  'bgl' AS dataset,
  line_no,
  CASE WHEN f.unix_s <> ''
    THEN to_timestamp(f.unix_s::BIGINT) + to_microseconds(f.micros::BIGINT)
  END AS ts,
  NULLIF(f.label, '') AS alert_label,
  NULLIF(f.node, '') AS node,
  NULLIF(f.source_type, '') AS source_type,
  NULLIF(f.component, '') AS component,
  NULLIF(f.level, '') AS level,
  CASE WHEN f.unix_s <> '' THEN coalesce(f.message, '') END AS message,
  hash(NULLIF(f.component, '') || '|' ||
    regexp_replace(regexp_replace(coalesce(f.message, ''),
      '0x[0-9a-fA-F]+', '<HEX>', 'g'), '[0-9]+', '<NUM>', 'g')) AS pattern_id
FROM parsed;
