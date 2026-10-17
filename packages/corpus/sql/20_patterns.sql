-- Pattern masks (concept R-04, technical.md § 7). DRAFT: the masks are
-- finalised and checked against the Loghub templates in U03.
--
-- A pattern is the message with variable identifiers and values replaced by
-- typed placeholders, within the same dataset and component. Diagnostic
-- codes stay, so `status: 404` and `status: 200` remain different patterns.
-- Each mask is one macro with its reason; log_pattern() applies them in a
-- fixed order. Changing a mask changes the SQL digest and therefore the data
-- version (src/manifest.ts); bump VERSIONS.patternRules in src/versions.ts so
-- the change is also visible by name.
--
-- SereneDB uses RE2: no look-behind, so codes are protected by tagging them
-- (pattern_protect_codes) before numbers are masked and untagged afterwards.

-- Timestamps inside messages: ISO-like, also URL-encoded in query strings
-- (changes-since=2017-05-16T21%3A44%3A58.589278%2B00%3A00), and ctime-like
-- dates in BGL DISCOVERY lines ("Wed Sep 14 12:34:56 PDT 2005").
CREATE OR REPLACE MACRO pattern_mask_ts(m) AS regexp_replace(
  regexp_replace(m,
    '\d{4}-\d{2}-\d{2}[-T ]\d{2}(?:[:.]|%3A)\d{2}(?:[:.]|%3A)\d{2}(?:\.\d+)?(?:Z|(?:[+-]|%2B)\d{2}(?::|%3A)?\d{2})?',
    '<TS>', 'g'),
  '\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) +\d{1,2} \d{2}:\d{2}:\d{2}(?: [A-Z]{3,4})? \d{4}\b',
  '<TS>', 'g');

-- OpenStack request IDs (req-<uuid>), before the general UUID mask.
CREATE OR REPLACE MACRO pattern_mask_req(m) AS regexp_replace(m,
  'req-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', '<REQ>', 'g');

-- Instance, image and other UUIDs.
CREATE OR REPLACE MACRO pattern_mask_uuid(m) AS regexp_replace(m,
  '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}', '<UUID>', 'g');

-- IPv4 addresses with optional port (client addresses, CioStream sockets).
CREATE OR REPLACE MACRO pattern_mask_ip(m) AS regexp_replace(m,
  '\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(?::\d+)?\b', '<IP>', 'g');

-- BGL node locations (R02-M1-N0-C:J12-U11, R00-M0-L3-U20-C, R63) and I/O
-- node names (bglio859).
CREATE OR REPLACE MACRO pattern_mask_node(m) AS regexp_replace(m,
  '\bR\d{2}(?:-[A-Za-z0-9]+(?::[A-Za-z0-9]+)?)*|\bbglio\d+\b', '<NODE>', 'g');

-- Hardware and software IDs: colon-separated hex bytes (BGL ido chip and
-- card IDs, FF:F2:9F:16:7F:D8:…) and hex strings of 16 or more digits
-- (OpenStack user and tenant IDs, image cache hashes, BGL ecid and card
-- serial numbers).
CREATE OR REPLACE MACRO pattern_mask_hex_id(m) AS regexp_replace(
  regexp_replace(m, '\b[0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){5,}\b', '<ID>', 'g'),
  '\b[0-9A-Fa-f]{16,}\b', '<ID>', 'g');

-- Memory addresses and register values (BGL). Forms observed: 0x…; bare
-- 8-digit hex words after register names ("iar 00106578 dear 045e23ac",
-- "softheader=009756d5", "status=ffbffbff", "register: …", "0:00000000"),
-- which may consist of digits only; and other 8-digit hex words with at least
-- one letter. An 8-digit decimal elsewhere is a count ("16176627 L3 EDRAM
-- error(s)") and is left to the number mask, so 7- and 8-digit counts form
-- one pattern.
CREATE OR REPLACE MACRO pattern_mask_addr(m) AS regexp_replace(
  regexp_replace(
    regexp_replace(m, '0x[0-9a-fA-F]+', '<ADDR>', 'g'),
    '(\b(?:iar|dear|lr) |softheader=|status=|register: |\b\d:)[0-9a-fA-F]{8}\b',
    '\1<ADDR>', 'g'),
  '\b(?:[a-fA-F][0-9a-fA-F]{7}|\d[a-fA-F][0-9a-fA-F]{6}|\d{2}[a-fA-F][0-9a-fA-F]{5}|\d{3}[a-fA-F][0-9a-fA-F]{4}|\d{4}[a-fA-F][0-9a-fA-F]{3}|\d{5}[a-fA-F][0-9a-fA-F]{2}|\d{6}[a-fA-F][0-9a-fA-F]|\d{7}[a-fA-F])\b',
  '<ADDR>', 'g');

-- Diagnostic codes that must survive the number mask: HTTP status, BGL
-- termination reasons, signal numbers, code/errno/rc values and the 0/1
-- state bits of BGL register dumps ("illegal instruction......1"). They are
-- tagged DIAGCODE<n>X so the word-bounded number mask cannot match them.
CREATE OR REPLACE MACRO pattern_protect_codes(m) AS regexp_replace(m,
  '(status: |reason |signal |code=|errno=|rc=|\.\.)(\d+)', '\1DIAGCODE\2X', 'g');

-- Remaining quantities, counts, durations and sizes.
CREATE OR REPLACE MACRO pattern_mask_num(m) AS regexp_replace(m,
  '\b\d+(?:\.\d+)?\b', '<NUM>', 'g');

CREATE OR REPLACE MACRO pattern_restore_codes(m) AS regexp_replace(m,
  'DIAGCODE(\d+)X', '\1', 'g');

CREATE OR REPLACE MACRO log_pattern(m) AS
  pattern_restore_codes(
  pattern_mask_num(
  pattern_protect_codes(
  pattern_mask_addr(
  pattern_mask_hex_id(
  pattern_mask_node(
  pattern_mask_ip(
  pattern_mask_uuid(
  pattern_mask_req(
  pattern_mask_ts(m))))))))));
