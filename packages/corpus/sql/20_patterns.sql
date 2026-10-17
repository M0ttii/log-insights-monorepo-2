-- Pattern masks (concept R-04, technical.md § 7). Finalised in U03 (LOG-12)
-- after both pattern checks: the Loghub comparison on the 2k samples
-- (sql/profiling/60_loghub_templates.sql, pinned by
-- tests/integration/patterns.test.ts) and the visual review on the full
-- corpus (sql/profiling/70_pattern_review.sql).
--
-- A pattern is the message with variable identifiers and values replaced by
-- typed placeholders, within the same dataset and component. Diagnostic
-- codes stay, so `status: 404` and `status: 200` remain different patterns.
-- Each mask is one macro with its reason; log_pattern() applies them in a
-- fixed order. Changing a mask changes the SQL digest and therefore the data
-- version (src/manifest.ts); bump VERSIONS.patternRules in src/versions.ts so
-- the change is also visible by name.
--
-- Diagnostic numbers, decided per dataset from the profile (U03):
--   BGL        termination reasons (`reason 1004`), signal numbers, exit
--              and message codes (`exit code 1`, `Message code 2`), error
--              numbers (`read error 0`) and the final 0/1 state bit of
--              register dumps (`illegal instruction......1`).
--   OpenStack  HTTP status (`status: 404`), response and exit codes
--              (`Bad response code …: 503`, `Exit code: 1`), the HTTP
--              version and the dated metadata API versions in paths
--              (`/openstack/2013-10-17`).
-- Every other number is a quantity, count, duration, size or identifier.
--
-- SereneDB uses RE2: no look-around, so codes are protected by tagging them
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

-- BGL only: file system paths. They name user programs, working
-- directories, node map files and command-line arguments of jobs
-- ("ciod: Error loading /home/…/vnm.rts: …", "LOGIN chdir(/p/gb2/…)"), so
-- each job would otherwise form its own pattern (Loghub check: templates
-- E25, E26, E28, E34, E37, E39 split by path). A path token starts with /,
-- ./ or ../ after a separator; program names without a slash are masked in
-- the two message forms that carry them. OpenStack paths stay: they are code
-- locations in tracebacks and fixed storage locations whose IDs are masked
-- separately. A colon belongs to the path unless a separator follows it
-- (".../V1R1M1_120_2005-050719_10:22:18Tue19Jul05/../8k.map: Bad file").
CREATE OR REPLACE MACRO pattern_mask_path(m) AS regexp_replace(
  regexp_replace(m,
    '(^|[\s(=,''"])\.{0,2}/(?:[^\s)''",:;]|:[^\s)''",:;])+', '\1<PATH>', 'g'),
  '(ciod: Error loading |core files for program )[^\s:<][^\s:]*', '\1<PATH>', 'g');

-- Operator user names of BGL service actions ("EndServiceAction 422 was
-- performed upon R77-M0-L1 by root", "PrepareForService is being done on
-- this rack (R63) by pjmccart"); review: one pattern per operator
-- otherwise. Only these two message forms end in "by <user>"; elsewhere
-- "by" is text ("Connection reset by peer").
CREATE OR REPLACE MACRO pattern_mask_user(m) AS regexp_replace(m,
  '^((?:EndServiceAction|PrepareForService) .* by )[A-Za-z][A-Za-z0-9_]*$', '\1<USER>');

-- Query strings of HTTP request lines. The endpoint (concept A-12) drops
-- them too; values such as changes-since and host differ per call. The
-- marker keeps polling calls with a query apart from plain list calls.
CREATE OR REPLACE MACRO pattern_mask_query(m) AS regexp_replace(m,
  '("[A-Z]+ [^\s?"]*)\?[^\s"]*', '\1?<QUERY>', 'g');

-- OpenStack request IDs (req-<uuid>), before the general UUID mask.
CREATE OR REPLACE MACRO pattern_mask_req(m) AS regexp_replace(m,
  'req-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', '<REQ>', 'g');

-- Instance, image and other UUIDs.
CREATE OR REPLACE MACRO pattern_mask_uuid(m) AS regexp_replace(m,
  '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}', '<UUID>', 'g');

-- IPv4 addresses with optional port (client addresses, CioStream sockets).
CREATE OR REPLACE MACRO pattern_mask_ip(m) AS regexp_replace(m,
  '\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(?::\d+)?\b', '<IP>', 'g');

-- BGL locations: node locations (R02-M1-N0-C:J12-U11, R00-M0-L3-U20-C,
-- R63), I/O node names (bglio859) and stand-alone card slot and unit
-- positions ("U01 node in processor card slot J05", "power module U58",
-- fan modules "J300 J301"; Loghub check: template E93 split by position).
CREATE OR REPLACE MACRO pattern_mask_node(m) AS regexp_replace(
  regexp_replace(m,
    '\bR\d{2}(?:-[A-Za-z0-9]+(?::[A-Za-z0-9]+)?)*|\bbglio\d+\b', '<NODE>', 'g'),
  '\b[JU]\d{2,3}\b', '<NODE>', 'g');

-- Hardware and software IDs: colon-separated hex bytes (BGL ido chip and
-- card IDs, FF:F2:9F:16:7F:D8:…) and hex strings of 16 or more digits
-- (OpenStack user and tenant IDs, image cache hashes, BGL ecid and card
-- serial numbers), and the build name of a started BGL daemon ("$Name:
-- V1R1M0_241_2005 $", one pattern per build otherwise).
CREATE OR REPLACE MACRO pattern_mask_hex_id(m) AS regexp_replace(
  regexp_replace(
    regexp_replace(m, '\b[0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){5,}\b', '<ID>', 'g'),
    '\b[0-9A-Fa-f]{16,}\b', '<ID>', 'g'),
  '\$Name: [^$]*\$', '$Name: <ID> $', 'g');

-- Memory addresses and register values (BGL). Forms observed: 0x… with
-- further 8-digit words of the same register ("fpr9=0x00000000 00000000
-- 00000000 bfe00000", one value; review: 155 fpr patterns split by which
-- word had no letter); the four hex words of a tree-network soft header
-- ("softheader=0064588e 8aff0003 00000002 00000000"); 8-digit hex words
-- after a register name or index ("iar 00106578 dear 045e23ac",
-- "PSR0=00001f01", "status=ffbffbff", "lr:00115504 cr:84848448",
-- "register: …", "10:00591040"), which may consist of digits only (Loghub
-- check: template E60 split where a word had no letter). Lower-case
-- "name=" values are counts ("index=12288, total=16777216") and stay with
-- the number mask. Other 8-digit
-- hex words with at least one letter. An 8-digit decimal elsewhere is a
-- count ("16176627 L3 EDRAM error(s)") and is left to the number mask, so 7-
-- and 8-digit counts form one pattern.
CREATE OR REPLACE MACRO pattern_mask_addr(m) AS regexp_replace(
  regexp_replace(
    regexp_replace(
      regexp_replace(m, '0x[0-9a-fA-F]+(?: [0-9a-fA-F]{8}\b)*', '<ADDR>', 'g'),
      'softheader=[0-9a-fA-F]{8} [0-9a-fA-F]{8} [0-9a-fA-F]{8} [0-9a-fA-F]{8}\b',
      'softheader=<ADDR> <ADDR> <ADDR> <ADDR>', 'g'),
    '(\b(?:iar|dear|lr) |\b(?:[A-Z][A-Z0-9]*|status)=|\b[a-z]+:|register: |\b\d{1,2}:)[0-9a-fA-F]{8}\b',
    '\1<ADDR>', 'g'),
  '\b(?:[a-fA-F][0-9a-fA-F]{7}|\d[a-fA-F][0-9a-fA-F]{6}|\d{2}[a-fA-F][0-9a-fA-F]{5}|\d{3}[a-fA-F][0-9a-fA-F]{4}|\d{4}[a-fA-F][0-9a-fA-F]{3}|\d{5}[a-fA-F][0-9a-fA-F]{2}|\d{6}[a-fA-F][0-9a-fA-F]|\d{7}[a-fA-F])\b',
  '<ADDR>', 'g');

-- Diagnostic numbers that must survive the number mask (see the list at the
-- top). They are tagged DIAGCODE<n>X so the word-bounded number mask cannot
-- match them. Dot leaders keep only a final 0/1 state bit; other values
-- after them are counts ("correctable errors detected in L3
-- EDRAMs........61"). "code" covers "exit code 1", "Exit code: 1", "Message code 2"
-- and "Bad response code while validating token: 503".
CREATE OR REPLACE MACRO pattern_protect_codes(m) AS regexp_replace(
  regexp_replace(
    regexp_replace(
      regexp_replace(m,
        '(status: |reason |signal |code=|errno=|rc=|\b[Cc]ode(?: [a-z]+)*:? |\berror )(\d+)',
        '\1DIAGCODE\2X', 'g'),
      '(\.\.)([01])$', '\1DIAGCODE\2X', 'g'),
    'HTTP/(\d+)\.(\d+)', 'HTTP/DIAGCODE\1X.DIAGCODE\2X', 'g'),
  '/(\d{4})-(\d{2})-(\d{2})\b', '/DIAGCODE\1X-DIAGCODE\2X-DIAGCODE\3X', 'g');

-- Remaining quantities, counts, durations and sizes, including sizes with a
-- unit suffix ("phys_ram=64172MB used_disk=20GB"; Loghub check: template
-- E32 split by size). The unit stays.
CREATE OR REPLACE MACRO pattern_mask_num(m) AS regexp_replace(m,
  '\b\d+(?:\.\d+)?([KMGT]B)?\b', '<NUM>\1', 'g');

CREATE OR REPLACE MACRO pattern_restore_codes(m) AS regexp_replace(m,
  'DIAGCODE(\d+)X', '\1', 'g');

CREATE OR REPLACE MACRO log_pattern(dataset, m) AS
  pattern_restore_codes(
  pattern_mask_num(
  pattern_protect_codes(
  pattern_mask_addr(
  pattern_mask_hex_id(
  pattern_mask_node(
  pattern_mask_ip(
  pattern_mask_uuid(
  pattern_mask_req(
  pattern_mask_query(
  pattern_mask_user(
  CASE WHEN dataset = 'bgl' THEN pattern_mask_path(pattern_mask_ts(m))
    ELSE pattern_mask_ts(m) END)))))))))));
