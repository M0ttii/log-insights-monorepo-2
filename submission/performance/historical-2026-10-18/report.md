# Observed receipt database timings

Sum of database round trips per successful persisted receipt, in milliseconds.

Status: measured; reason: none; n: 9.

Receipt creation window (UTC): 2026-10-17T22:52:44.585000Z through 2026-10-18T15:08:49.063000Z.

| Data version | Tool | Tool version | Client | n | Median ms | p95 ms | Min ms | Max ms | First receipt UTC | Last receipt UTC |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- |
| dv_7ea6fcb2c9eb6882 | count_events | 1.2.0 | eval | 1 | 18.18 | 18.18 | 18.18 | 18.18 | 2026-10-18T15:06:16.702000Z | 2026-10-18T15:06:16.702000Z |
| dv_7ea6fcb2c9eb6882 | describe_corpus | 1.0.0 | test | 1 | 4 | 4 | 4 | 4 | 2026-10-18T09:59:49.385000Z | 2026-10-18T09:59:49.385000Z |
| dv_7ea6fcb2c9eb6882 | event_trend | 1.1.0 | web | 1 | 20.85 | 20.85 | 20.85 | 20.85 | 2026-10-18T15:08:49.063000Z | 2026-10-18T15:08:49.063000Z |
| dv_7ea6fcb2c9eb6882 | get_log_context | 1.0.0 | test | 1 | 3444.95 | 3444.95 | 3444.95 | 3444.95 | 2026-10-18T11:50:45.045000Z | 2026-10-18T11:50:45.045000Z |
| dv_7ea6fcb2c9eb6882 | latency_stats | 1.0.0 | test | 1 | 11.8 | 11.8 | 11.8 | 11.8 | 2026-10-18T12:56:19.046000Z | 2026-10-18T12:56:19.046000Z |
| dv_7ea6fcb2c9eb6882 | recurring_patterns | 1.1.0 | test | 1 | 157.83 | 157.83 | 157.83 | 157.83 | 2026-10-18T11:52:09.353000Z | 2026-10-18T11:52:09.353000Z |
| dv_7ea6fcb2c9eb6882 | search_logs | 1.0.0 | mcp | 2 | 25.849999999999998 | 31.942999999999998 | 19.08 | 32.62 | 2026-10-17T22:52:44.585000Z | 2026-10-17T23:35:07.537000Z |
| dv_7ea6fcb2c9eb6882 | search_logs | 1.1.0 | test | 1 | 27.65 | 27.65 | 27.65 | 27.65 | 2026-10-18T12:56:16.834000Z | 2026-10-18T12:56:16.834000Z |

- duration_ms sums pg database round trips, including network time; it is neither engine CPU time nor end-to-end investigation latency.
- This is a retrospective summary of successful persisted receipts, not a controlled benchmark; failures without receipts are absent and cache state, concurrency and machine load are unknown.
- Groups separate data version, tool, tool version and client; scopes and query signatures can still differ within a group, so groups are not directly comparable workloads.
- The date window refers to receipt creation times, not corpus event times; filters include from and exclude to.
- Continuous sample p95 is descriptive even for small n; no tail-latency or performance guarantee follows from it.
- Only canonical r_XXXXXXXX.json receipt files are selected; temporary and unrelated files are excluded. File hashes bind the exact source bytes for replay.

## Source snapshot

The companion report.json preserves the exact SQL, bound parameters, filters, source signatures and result digests. SHA-256 below identifies each complete source file; re-running needs those unchanged receipts in the fixed database mount.

| Receipt file | SHA-256 |
| --- | --- |
| r_1f63d33f.json | 826ed4cc5d2a4c60b14a5d04aa6924f6cf9b54d1aa2cd491b0d79f25b8cc3b4d |
| r_2bb56624.json | 391c5aee14925fddbd024ec93ca9e0d81f958119108abde37ded5ffded1eb27d |
| r_62ef5805.json | 802e4007d66d3e6eb3a32a8a22a8f006db47300de261f66099a46d683a354960 |
| r_676abcd3.json | 5a004eb6c4ba8213d017c77ecc9883ec249e06c77b01437a97c6e5e9b411c9ec |
| r_71fdf89a.json | 116fd544ecde9811283b993726d0763a206f0f41f3add7815cb156c4cc4a14a5 |
| r_84999dea.json | 2e61e8bc1102bd0679136e8155df3272bfc16fd3fb1d08f1d3b906a108f8d70b |
| r_c25c95da.json | d18ebbbb5fac62d6bacd005b740d97caeca9600550b9c99260d6ebbb2e911aca |
| r_c59fbe9e.json | aa023b6573c6c316552c4d79d3cb8a0670ee4d562c5f1578c452e6577a846221 |
| r_feb1ffab.json | 0d33dd2174c45f9224466568eb72b28aa9062717119253fa63bfc14f54b18187 |
