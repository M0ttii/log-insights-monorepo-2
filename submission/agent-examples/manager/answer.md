## BGL: what to investigate first (Manager view)

**Scope**
- Dataset: BGL. No time window was requested, so the ranking uses the full data span [`2005-06-03T22:42:50Z` [r_d1c334b8.f45], `2006-01-04T16:00:05Z` [r_d1c334b8.f46]) UTC.
- Candidates are error and alert patterns only: 514 patterns [r_d1c334b8.f4], 988,783 log events [r_d1c334b8.f3].
- To see whether things are growing, I compared [`2005-12-05T16:00:06Z` [r_07799ce0.f26], `2006-01-04T16:00:06Z` [r_07799ce0.f27]) with the same-length period starting `2005-11-05T16:00:06Z` [r_07799ce0.f28]. The recent window runs past the end of the data, so it only counts the part that was recorded.

**Answer**
Investigate the KERNEL pattern `instruction address: <ADDR>` first. Across the full span it has more episodes than every other candidate, and the tool ranks it as a clear first priority. It is spread across many nodes rather than concentrated on a few, and it fell slightly in the last month compared with the month before. The other two priorities are also recurring KERNEL FATAL patterns.

### Priorities

| | Pattern | Episodes | Events | Breadth | Change, last month vs. month before | Severity cues | Team (fictional) |
|---|---|---|---|---|---|---|---|
| 1 | `20306c79d929c187` "instruction address: <ADDR>" | 289 [r_d1c334b8.f14] | 47,563 [r_d1c334b8.f15] | 22,791 nodes [r_d1c334b8.f19], 64 racks [r_d1c334b8.f20] | 22 [r_5bd227d1.f11] vs. 48 [r_5bd227d1.f7], delta −26 [r_5bd227d1.f9]; status ongoing | FATAL, no dataset label | Compute Platform |
| 2 | `83eb1a593767ea54` "wait state enable.................0" | 260 [r_d1c334b8.f25] | 6,561 [r_d1c334b8.f26] | 6,476 nodes [r_d1c334b8.f30], 62 racks [r_d1c334b8.f31] | 31 [r_24c7822a.f11] vs. 61 [r_24c7822a.f7], delta −30 [r_24c7822a.f9]; ongoing | FATAL, no label | Compute Platform |
| 3 | `e1726baa21cb58fe` "instruction plb error.............0" | 260 [r_d1c334b8.f36] | 297 [r_d1c334b8.f37] | 252 nodes [r_d1c334b8.f41], 64 racks [r_d1c334b8.f42] | 31 [r_139b6813.f11] vs. 45 [r_139b6813.f7], delta −14 [r_139b6813.f9]; ongoing | FATAL, no label | Compute Platform |

**Change by team (error events, same two windows):**
- Compute Platform: 6,266 [r_07799ce0.f7] vs. 17,967 [r_07799ce0.f5], delta −11,701 [r_07799ce0.f6].
- Workload Runtime: 32,146 [r_07799ce0.f17] vs. 30,930 [r_07799ce0.f15], delta +1,216 [r_07799ce0.f16]. This is the only team whose errors increased, though none of its patterns made the top three.

### Why this order
- **What the ranking used:** episodes first, then events, then pattern ID as a tiebreaker.
- **What it left out:**
  - Breadth was dropped from the ranking because some candidates have events without a node, so it couldn't be measured for every candidate. The node counts in the table are shown for context only.
  - Change was dropped because the period before the full span lies outside the data.
- **Dominance:** the leader outranks all 513 other candidates [r_d1c334b8.f5] on episodes, so there is no trade-off to weigh at the top.
- **Priorities 2 and 3** tie on episodes. Priority 2 comes first because it has more events, the next tiebreaker. Priority 3 has far fewer events and nodes, so it is narrower.
- **Limits:** this is a technical investigation order, not a measure of severity or business risk. A rare but severe problem can rank lower, and the event counts are context, not the ranking criterion.

### Decision needed
- Assign Compute Platform (fictional owner of KERNEL) to investigate the leading pattern, since it has the most episodes and is widespread.
- Patterns 2 and 3 are also Compute Platform's. Decide whether to look at all three together.
- Decide whether Workload Runtime should look into its rising error volume separately, as a team-level trend rather than a ranked pattern.

### Missing information
- **Business impact unknown**, including downtime, cost and user or job effects.
- Breadth and change could not be ranking criteria over the full span.
- The recent comparison window only partly covers recorded data.
- No information on which jobs were affected or whether any repairs were made.

**Unknown**
- The cause of all three patterns is open. Seeing them on many nodes describes how widely the symptom shows up, not where it comes from.
- Episodes are bursts of log lines, not incidents or outages.
- Only the top three of the 514 candidates are listed.

**Verification**
- Batch 1: 26 claims checked [r_c5b60807.f1] · 0 mismatch [r_c5b60807.f2] · 0 unresolved [r_c5b60807.f3].
- Batch 2: 9 claims checked [r_f365f31a.f1] · 0 mismatch [r_f365f31a.f2] · 0 unresolved [r_f365f31a.f3].
- Only the numbers were checked, not the explanations.