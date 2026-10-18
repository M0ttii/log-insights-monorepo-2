# HDFS — Team Lead

Question: Which recurring WARN patterns does the Storage Platform team have, and how are they distributed over the two days?

## Scope

Dataset `hdfs` (HDFS_v1, full corpus, data version `dv_02dfa8cc8e16e2a2`), full data span, filtered to level `WARN` and the fictional owning team `Storage Platform`. HDFS has two days of data (2008-11-09 to 2008-11-11). Ownership is fictional and labelled as such.

## Answer

In scope the team's WARN lines fall into 4 patterns [r_fa625aeb.f4] over 361,771 log events [r_fa625aeb.f3]. The 361,771 log events [r_b2a7339d.f2] owned by `Storage Platform` are dominated by two recurring patterns.

Recurring WARN patterns (by episodes, then events):

| pattern                                                                                                | events                              | episodes                    | active days            |
| ------------------------------------------------------------------------------------------------------ | ----------------------------------- | --------------------------- | ---------------------- |
| `2ccea1080d47f97f` `Unexpected error trying to delete block <BLOCK>. BlockInfo not found in volumeMa…` | 5,545 log events [r_fa625aeb.f10]   | 18 episodes [r_fa625aeb.f9] | 3 days [r_fa625aeb.f5] |
| `aaa322fbb9fe5db9` `<IP>:Got exception while serving <BLOCK> to /<IP>:`                                | 356,207 log events [r_fa625aeb.f18] | 8 episodes [r_fa625aeb.f17] | —                      |

Both are recurring (far more than the two-episode threshold). Over the UTC days, the team's WARN volume is 361,771 log events [r_3c14789d.f9], split 91,734 log events [r_3c14789d.f2] in the first bucket and 246,616 log events [r_3c14789d.f3] in the second; a short tail falls in the final partial day (see the day-trend receipt).

## Recurring vs. one-off

Each listed pattern has many episodes across the span, so these are recurring, not single bursts. The day trend shows volume on both full days rather than one isolated spike.

## Investigate first

The leading pattern by episodes (`2ccea1080d47f97f`) is the natural first review for `Storage Platform`: it recurs most and carries the most WARN events among the team's patterns. Propose a team review of that pattern's data-node write/replication path. Investigation proposal only — no production change.

## Unknown

HDFS WARN is a warning, not an error (R-02: HDFS error levels never occur here), so these are not failures or outages. Business impact is unknown. Ownership is fictional. The two-day span is short; buckets outside it are not zero. Breadth by block is not asserted here.

## Verification

check_claims receipt `r_61b31012`: 11 claims checked · 0 mismatch · 0 unresolved.
