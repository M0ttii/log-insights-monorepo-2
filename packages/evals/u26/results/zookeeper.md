# ZooKeeper — Engineer

Question: What precedes the shutdown-exception errors?

## Scope

Dataset `zookeeper` (ZooKeeper of 32 machines, aggregated, full corpus, data version `dv_02dfa8cc8e16e2a2`), full data span (2015-07-29 to 2015-08-25). Anchor condition: all words of `Unexpected exception causing shutdown` (search terms), restricted to this dataset. Precursor analysis in `before` mode, window 10 minutes; episode starts (gap ≥ 30 min) are the anchors. ZooKeeper error levels are `ERROR`, `FATAL` (R-02).

## Evidence

`search_logs` returns 590 log events [r_b15d2a2b.f6] matching the shutdown-exception text. The precursor pass matches 590 log events [r_73ece7e0.f56] and reduces them to 7 anchors [r_73ece7e0.f1] (episode starts; bursts collapse to one anchor each). Dataset-wide, log events by level total 74,380 log events [r_088031dc.f8], of which 617 log events [r_088031dc.f6] are level `ERROR`.

## Timeline (precursors)

Among the shutdown anchors, the most frequent preceding pattern appears before 3 anchors [r_73ece7e0.f6] of them (anchor share 0.42857142857142855 ratio [r_73ece7e0.f5]); this is a temporal observation, never a cause. Precursors are observations before the anchors, not causes.

## Narrowing

The shutdown-exception events are ERROR-level ZooKeeper lines (owned by the fictional `Coordination Services` team). Use the aggregate anchors, not the raw search total, as the count of distinct shutdown episodes.

## Hypotheses

- A repeated preceding pattern is associated with shutdown episodes | open | the before-window shows which patterns recur ahead of anchors, but temporal precedence is not causation and the base rate is bounded by the anchor count | executed check: get_log_context aggregate (receipt below).

## Next check

Open the leading precursor pattern with get_log_context event mode on the same thread around a shutdown anchor, and compare its before/after presence. Observable: whether the precursor is concentrated ahead of shutdowns versus spread across the span. Concentration would support the association; absence would leave it open. A matching precursor still cannot prove the shutdown's cause.

## Unknown

Root cause of the shutdowns is unknown. Business impact is unknown. The precursor base rate is bounded by the number of anchors; a precursor is never a cause. Ownership is fictional.

## Verification

check_claims receipt `r_a44f02ea`: 7 claims checked · 0 mismatch · 0 unresolved.
