# Worked investigation: control-stream failures during BGL job startup

Inspect the job-start working directory and program image before prioritizing a
network repair. The executed checks show broadly emitted control-stream failures
and a repeated temporal association with a missing working directory. They do not
identify the initiating node, prove a shared job identity or establish a cause.

This is an analyst-written walkthrough of a known development/demo case. The
registered tools ran directly against the loaded full base corpus. No new Claude
answer, API call, baseline comparison or holdout run was generated. The role
sections below illustrate decisions supported by these receipts, not measured
client compliance. [Capture manifest](worked-investigation/manifest.json) records
the code/data versions, complete receipts, hashes and successful registry re-runs.

## Scope and load balance

The requested BGL window is [2005-06-01T00:00:00Z [`r_bcd0408f.f15`](evidence/r_bcd0408f.json), 2005-07-01T00:00:00Z [`r_bcd0408f.f16`](evidence/r_bcd0408f.json)), UTC. BGL records start at
2005-06-03T22:42:50.363779Z [`r_45c7a4ec.f50`](evidence/r_45c7a4ec.json); the unrecorded portion of the
requested window is unknown, not observed calm. The dataset label `APPREAD`
selects the documented example; it is a source annotation, not our finding.
Ownership is fictional: `APP` maps to **Workload Runtime**.

| Dataset | Lines read | Loaded log events | Rejected lines | First / last observed event, UTC (both included) |
|---|---:|---:|---:|---|
| BGL | 4,747,963 [`r_45c7a4ec.f58`](evidence/r_45c7a4ec.json) | 4,747,945 [`r_8f3bdd12.f4`](evidence/r_8f3bdd12.json) | 18 [`r_45c7a4ec.f59`](evidence/r_45c7a4ec.json) | 2005-06-03T22:42:50.363779Z [`r_45c7a4ec.f50`](evidence/r_45c7a4ec.json) / 2006-01-04T16:00:05.233639Z [`r_45c7a4ec.f51`](evidence/r_45c7a4ec.json) |
| OpenStack | 207,820 [`r_45c7a4ec.f126`](evidence/r_45c7a4ec.json) | 207,820 [`r_2c4302ad.f4`](evidence/r_2c4302ad.json) | 0 [`r_45c7a4ec.f127`](evidence/r_45c7a4ec.json) | 2017-05-14T19:39:01.445000Z [`r_45c7a4ec.f120`](evidence/r_45c7a4ec.json) / 2017-05-17T12:02:35.320000Z [`r_45c7a4ec.f121`](evidence/r_45c7a4ec.json) |

Population counts are full-span `count_events` aggregations with an explicit
dataset filter. The load balance comes from `describe_corpus`. Their
recorded data version is `dv_229e422f86a9fc6e`.
BGL and OpenStack are different systems with separate time axes. The OpenStack
section is a separate companion example, not corroboration of the BGL cause.

## Initial assessment, recorded before the original check

The original author recorded the APPREAD hypothesis in LOG-12 before full-corpus
profiling: a systemic job/network event at the I/O nodes was considered more
likely than a defective node. That was explicitly untested background reasoning.
The authoritative comment timestamp is `2026-10-17T17:28:36.002Z`; a later comment
corrected the inaccurate clock time typed into its body.

The [initial-assessment excerpt](worked-investigation/initial-assessment.json)
preserves the original German text, comment IDs, timestamps and source link.
This historical hypothesis predates the original profiling. The present walkthrough
reproduces a known case; it is not a new prospective or blinded experiment.

## Retrieval and executed discriminating checks

### Search and population

A phrase search for `failed to read message prefix` returns
5,983 [`r_b63b6c6e.f4`](evidence/r_b63b6c6e.json) matches in the requested window.
The saved hit list is truncated; its examples are not a population estimate.
The separate APPREAD aggregation counts 5,983 [`r_bcd0408f.f3`](evidence/r_bcd0408f.json)
log events, 7 [`r_bcd0408f.f8`](evidence/r_bcd0408f.json) episodes and
5 [`r_bcd0408f.f5`](evidence/r_bcd0408f.json) active days. An episode
starts after the gap defined in the receipt:
30 [`r_bcd0408f.f14`](evidence/r_bcd0408f.json) minutes.
Episodes are computed after filtering. They are not incidents, outages or jobs.

The aggregation reports 512 [`r_bcd0408f.f12`](evidence/r_bcd0408f.json) emitting
nodes and 32 [`r_bcd0408f.f13`](evidence/r_bcd0408f.json) racks. The node-count
call lists a bounded selection and an explicit rest group; it does not prove equal
counts for all nodes. The rack list is complete. These month-level counts
contradict **symptoms confined to a node**. They do not rule out a single initiating
node or shared component, prove per-episode synchrony or establish machine-wide
failure. A direct midplane aggregate is not available in the current contract.

### Original event sequence

The context call uses `same_component`, retaining APP events on other nodes. It
is explicitly broader than a same-node lookup. Below are original messages, not
normalized patterns or rewritten log evidence. Event IDs identify records and
are not counts. The receipt contains the full validated input and window.

| Event ID | UTC time | Offset from anchor, ms | Node | Original message |
|---|---|---:|---|---|
| `14736` | 2005-06-04T07:24:31.560279Z [`r_b6ce5f6c.f9`](evidence/r_b6ce5f6c.json) | -838.005 [`r_b6ce5f6c.f8`](evidence/r_b6ce5f6c.json) | `R23-M0-N4-I:J18-U11` | `ciod: LOGIN chdir(/p/gb2/draeger/benchmark/dat32k_060205) failed: No such file or directory` |
| `14737` | 2005-06-04T07:24:31.594456Z [`r_b6ce5f6c.f11`](evidence/r_b6ce5f6c.json) | -803.828 [`r_b6ce5f6c.f10`](evidence/r_b6ce5f6c.json) | `R23-M1-N8-I:J18-U01` | `ciod: LOGIN chdir(/p/gb2/draeger/benchmark/dat32k_060205) failed: No such file or directory` |
| `14738` | 2005-06-04T07:24:32.398284Z [`r_b6ce5f6c.f1`](evidence/r_b6ce5f6c.json) | Anchor | `R23-M1-N8-I:J18-U11` | `ciod: failed to read message prefix on control stream (CioStream socket to 172.16.96.116:33399` |
| `14739` | 2005-06-04T07:24:32.432192Z [`r_b6ce5f6c.f3`](evidence/r_b6ce5f6c.json) | 33.908 [`r_b6ce5f6c.f2`](evidence/r_b6ce5f6c.json) | `R04-M1-N4-I:J18-U11` | `ciod: failed to read message prefix on control stream (CioStream socket to 172.16.96.116:33569` |

The context after the anchor is truncated: it contains
1,021 [`r_b6ce5f6c.f13`](evidence/r_b6ce5f6c.json) in-window events but shows only
the requested neighbours. The table is an excerpt of that bounded result. Neither
it nor the aggregate precursor result assigns the remaining context to a specific
job or reconstructs every episode. [complete receipt](evidence/r_b6ce5f6c.json).

### Precursor check across episode starts

The aggregate check uses the APPREAD pattern as the anchor selector. Its preceding
window is the validated `window_minutes` parameter in the
[complete receipt](evidence/r_16d9e58b.json). Context candidates come from the dataset, including
other nodes and components. The anchor pattern is excluded.

| Quantity | Executed result |
|---|---|
| Episode-start anchors | 7 [`r_16d9e58b.f1`](evidence/r_16d9e58b.json) |
| Anchors preceded by `LOGIN chdir(<PATH>) failed: No such file or directory` | 6 [`r_16d9e58b.f6`](evidence/r_16d9e58b.json) |
| Anchor share, ratio | 0.857143 [`r_16d9e58b.f5`](evidence/r_16d9e58b.json) |
| Background grid windows containing that pattern | 23 [`r_16d9e58b.f8`](evidence/r_16d9e58b.json) |
| All background grid windows | 3,896 [`r_16d9e58b.f4`](evidence/r_16d9e58b.json) |
| Background-window rate, ratio | 0.00590349 [`r_16d9e58b.f7`](evidence/r_16d9e58b.json) |
| Anchor share / background-window rate, ratio | 145.193 [`r_16d9e58b.f9`](evidence/r_16d9e58b.json) |
| Background grid start, inclusive | 2005-06-03T22:42:50.363779Z [`r_16d9e58b.f2`](evidence/r_16d9e58b.json) |
| Background grid end, exclusive | 2005-07-01T00:00:00Z [`r_16d9e58b.f3`](evidence/r_16d9e58b.json) |

SereneDB computed the shares and their ratio. This scoped grid starts at the first
recorded BGL event. It includes empty windows inside the observed span and may
end with a partial window. It is a descriptive temporal baseline, not a randomized
control or a significance test. The precursor list is complete for this call.
A historical full-span precursor ratio uses a different denominator and must not
be substituted for this June-scoped value.

### Effect on the assessment

| Hypothesis | Status | Discriminating check and implication |
|---|---|---|
| The observed symptoms are confined to a node | `contradicted` | The emitting-node breadth is 512 [`r_bcd0408f.f12`](evidence/r_bcd0408f.json). This tests symptom confinement only. |
| Missing-working-directory errors are temporally associated with APPREAD episode starts | `supported` | Preceding occurrences at 6 [`r_16d9e58b.f6`](evidence/r_16d9e58b.json) of 7 [`r_16d9e58b.f1`](evidence/r_16d9e58b.json) anchors, plus the quoted event sequence. Supported temporal association is not causal proof. |
| A network fault, an initiating node or a job-start configuration defect caused the failures | `open` | Neither symptom breadth nor precursor enrichment identifies the origin. Needed check: match job allocation, submission working directory, filesystem/mount availability and transport evidence to the affected control streams. |

The executed check changes the **next investigation step**: inspect job-start
inputs and working-directory accessibility before recommending network repair.
The original systemic explanation becomes narrower as an investigation direction,
without turning a precursor into a proven cause. No repair, ticket creation or
paging action was performed.

## Engineer view

**Question:** On BGL in the requested June window, is the control-stream failure
confined to a node, and what evidence would distinguish its initiating origin?

**Scope:** The requested BGL window above; APPREAD evidence and APP context on
other nodes. **Answer:** Symptoms are distributed; the initiating origin remains
open. **Evidence and timeline:** the original sequence and precursor table above.
**Narrowing:** emitting nodes are distinct from causal origin, and month breadth
does not establish per-episode synchrony. **Hypotheses:** the explicit statuses
and discriminating checks in the preceding table.

**Next check:** Workload Runtime should recover the job submission record and
check the logged working directory, its availability on the involved I/O nodes
and the program image at startup. Compare successful starts and failures before
choosing a filesystem/configuration or network intervention. A matching job and
initiating evidence are the completion conditions for this check.

**Unknown:** initiating component, affected-job boundaries, why the path was
unavailable, outage duration and customer effect. **Verification:** see the
archived claim-check batches below. They check cited values, not the explanation.

## Team Lead view

**Question:** Which Workload Runtime problems recur in the same BGL window, and
what should the team investigate first?

**Scope:** Same dataset/window, fictional Workload Runtime ownership.
**Answer:** Investigate job-start input availability and the recurring load/chdir
errors alongside the control-stream symptom.

**Recurring patterns and recurring versus one-off:** The team-scoped pattern
result is truncated. It reports 8 [`r_a7df3aee.f4`](evidence/r_a7df3aee.json)
patterns overall; the following are named candidates, not an exhaustive summary.

| Pattern | Episodes | Active days | Emitting nodes | Log events |
|---|---:|---:|---:|---:|
| `ciod: Error loading <PATH>: invalid or missing program image, No such file or directory` | 22 [`r_8207d0e9.f16`](evidence/r_8207d0e9.json) | 15 [`r_8207d0e9.f13`](evidence/r_8207d0e9.json) | 512 [`r_8207d0e9.f21`](evidence/r_8207d0e9.json) | 3,384 [`r_8207d0e9.f17`](evidence/r_8207d0e9.json) |
| `ciod: LOGIN chdir(<PATH>) failed: No such file or directory` | 14 [`r_8207d0e9.f27`](evidence/r_8207d0e9.json) | 11 [`r_8207d0e9.f24`](evidence/r_8207d0e9.json) | 480 [`r_8207d0e9.f32`](evidence/r_8207d0e9.json) | 2,178 [`r_8207d0e9.f28`](evidence/r_8207d0e9.json) |
| `ciod: failed to read message prefix on control stream (CioStream socket to <IP>` | 7 [`r_8207d0e9.f38`](evidence/r_8207d0e9.json) | 5 [`r_8207d0e9.f35`](evidence/r_8207d0e9.json) | 512 [`r_8207d0e9.f44`](evidence/r_8207d0e9.json) | 5,983 [`r_8207d0e9.f39`](evidence/r_8207d0e9.json) |

**Trend and previous-period check:** The team total is
13,409 [`r_ef9745b3.f4`](evidence/r_ef9745b3.json) log events. The weekly table below contains
all team log events, including the tool's rest group. Boundaries are UTC bucket
labels from the receipt, not extra observed days. The edge buckets are partial;
compare their coverage before interpreting their size.

| UTC bucket label, start / end | Team log events | Partial coverage |
|---|---:|---|
| `2005-05-30T00:00:00.000000Z` / `2005-06-06T00:00:00.000000Z` | 2,408 [`r_c53dc64f.f2`](evidence/r_c53dc64f.json) | true |
| `2005-06-06T00:00:00.000000Z` / `2005-06-13T00:00:00.000000Z` | 2,240 [`r_c53dc64f.f9`](evidence/r_c53dc64f.json) | false |
| `2005-06-13T00:00:00.000000Z` / `2005-06-20T00:00:00.000000Z` | 3,393 [`r_c53dc64f.f16`](evidence/r_c53dc64f.json) | false |
| `2005-06-20T00:00:00.000000Z` / `2005-06-27T00:00:00.000000Z` | 4,200 [`r_c53dc64f.f23`](evidence/r_c53dc64f.json) | false |
| `2005-06-27T00:00:00.000000Z` / `2005-07-04T00:00:00.000000Z` | 1,168 [`r_c53dc64f.f30`](evidence/r_c53dc64f.json) | true |

The executed comparison reports `determinable: false`: its reference window
[2005-05-02T00:00:00.000000Z [`r_ef9745b3.f7`](evidence/r_ef9745b3.json),
2005-06-01T00:00:00.000000Z [`r_ef9745b3.f8`](evidence/r_ef9745b3.json)) is outside the BGL data span.
Baseline, delta, percentage change and classification remain null. No growth,
recovery or newly appearing problem is claimed. [complete receipt](evidence/r_ef9745b3.json).

**Investigate first / improvement:** Assign the known job-start case to
Workload Runtime. Review submission-directory and program-image validation,
then consider a preflight/runbook change if that check confirms an input or
availability defect. Keep successful-start counterexamples and compare them with
failures. This recommendation is conditional, not an autonomous fix.

**Unknown:** prior-period trend, cause, and business effect. **Verification:**
the archived checks below cover the cited pattern, breadth and trend values.

## Manager view

**Question:** Where should Workload Runtime investigation effort go first in
this BGL window, and what does the wider BGL portfolio leave uncertain?

**Scope:** Same BGL window. The primary ranking is explicitly team-scoped;
the separately executed BGL-wide ranking is a different population.
**Answer:** Fund the program-image/job-start availability check before treating
the largest control-stream line count as the first priority.

**Priorities and why this order:** Use the named candidates in the Team Lead
table. SereneDB evaluates 8 [`r_8207d0e9.f4`](evidence/r_8207d0e9.json)
team candidates and returns `clear_priority` for the program-image loading
pattern. It leads on episodes
(22 [`r_8207d0e9.f9`](evidence/r_8207d0e9.json)) and
shares the breadth maximum
(512 [`r_8207d0e9.f7`](evidence/r_8207d0e9.json) nodes).
APPREAD carries the largest event count
(5,983 [`r_8207d0e9.f11`](evidence/r_8207d0e9.json)); line
volume alone would direct attention differently. The ranking uses episodes,
breadth, then events and the stable pattern-ID tiebreaker. Increase is dropped
because the reference period is unavailable. No composite risk score is used.
The visible candidate list is truncated; dominance is evaluated over the complete
candidate population.

The BGL-wide call places `rts panic! - stopping execution` first by its
34 [`r_7643eff2.f14`](evidence/r_7643eff2.json) episodes. In that wider scope,
breadth is dropped because not every candidate has a node; increase is also
unavailable. Its order must not be presented as a complete ranking by breadth
or merged with the team ranking. [complete receipt](evidence/r_7643eff2.json).

**Decision needed:** Give Workload Runtime a bounded investigation into job-start
inputs, with the Compute Platform portfolio retained as a separate allocation
choice. Revisit the allocation when initiating evidence or service-impact
information arrives. The tool's technical order is not a severity or business-risk
assessment.

**Missing information / Unknown:** recurrence is observed, growth is not
measurable here, and business impact is unknown. No downtime, cost, customer loss
or causal repair priority follows from these log counts. **Verification:** see
archived claim checks; there is no Manager hypothesis section or causal verdict.

## Separate OpenStack companion example

The OpenStack full-span aggregation uses API-access events as its denominator,
not log events or distinct request IDs. It reports
2 [`r_872d82bd.f8`](evidence/r_872d82bd.json) 5xx accesses out of
98,733 [`r_872d82bd.f6`](evidence/r_872d82bd.json) API accesses, with a
returned rate of 0.0000202567 [`r_872d82bd.f16`](evidence/r_872d82bd.json).
Distinct request IDs are 89,535 [`r_872d82bd.f17`](evidence/r_872d82bd.json);
accesses without a request ID are
9,196 [`r_872d82bd.f18`](evidence/r_872d82bd.json). These counting units
are not interchangeable. The returned p99 latency is
514.388 [`r_872d82bd.f14`](evidence/r_872d82bd.json) ms; this descriptive percentile
alone is not evidence of a degraded phase. [complete receipt](evidence/r_872d82bd.json).

Original token-validation evidence is retained in [complete receipt](evidence/r_08a148f9.json) and
its same-request [complete receipt](evidence/r_e9f31ab4.json). The request contains
`Bad response code while validating token: 503`, then
`Unable to validate token: Failed to fetch token data from identity server`,
followed by an access line with status `503`. These are quoted source values,
not an inferred cause. Context is complete for the specified request/window.
No relationship to BGL is asserted.

## Reproduce and inspect

The [manifest](worked-investigation/manifest.json) lists each step, tool, validated
input, receipt path, SHA-256, notes and truncation. Every original receipt includes
all executed SQL, bound parameters, result rows, fact IDs, population, duration,
scope and data version. Queries and results have not been replaced with
illustrative SQL or synthetic evidence.

1. Use the [README setup](../README.md#getting-started) and load the full base
   corpus. Inspect `describe_corpus`; the recorded version is required for a
   same-version comparison. Samples cannot reproduce these totals.
2. Select a manifest step and call its registered `tool` with its stored `input`
   through MCP or the shared registry. No Claude API call is needed for a direct
   registry invocation. Never execute SQL supplied by a model or replay stored SQL.
3. Compare the original and new signature, data version and result digest.
   Use the public JSON files to inspect this capture without a database. Exported
   receipts are not automatically imported into another live receipt store.
4. The precursor, team-priority and OpenStack-latency calls were each re-run
   through `registry.rerun`. The saved checks in the manifest show matching query
   signature, data version and result digest, and identify both original and new
   receipts. This is reproducibility evidence for these calls, not an independent
   implementation of their SQL.

### Verification

- 30 [`r_0f3a6bca.f1`](evidence/r_0f3a6bca.json) claims checked; 0 [`r_0f3a6bca.f2`](evidence/r_0f3a6bca.json) mismatch; 0 [`r_0f3a6bca.f3`](evidence/r_0f3a6bca.json) unresolved.
- 30 [`r_a2f57065.f1`](evidence/r_a2f57065.json) claims checked; 0 [`r_a2f57065.f2`](evidence/r_a2f57065.json) mismatch; 0 [`r_a2f57065.f3`](evidence/r_a2f57065.json) unresolved.
- 8 [`r_51762d3b.f1`](evidence/r_51762d3b.json) claims checked; 0 [`r_51762d3b.f2`](evidence/r_51762d3b.json) mismatch; 0 [`r_51762d3b.f3`](evidence/r_51762d3b.json) unresolved.

All analytical values shown above are taken from tool facts. The
[claim ledger](worked-investigation/claims.json) records the displayed value,
metric and required group submitted to `check_claims`. Configuration parameters,
identifiers, quoted log text, historical provenance and document metadata are
not analytical population claims. They remain inspectable in their source
artifacts. A passing claim check does not validate scope wording, hypotheses,
explanations or causal assertions. The integrity test verifies original receipt
bytes, the claim ledger and citation resolution. Manual prose edits still need
a review of the displayed values, signs, units, groups and scope against those
receipts; keeping a valid fact ID alone does not detect a changed prose number.

### Limits and attribution

Independent full-corpus Golden SQL remains under
[analytics/tests/golden](../packages/analytics/tests/golden/). The [verification record](worked-investigation/verification.json) records the
actual passing base-corpus suites and the initial environment-related failures
separately. No
holdout content was read and no client/Web or A-21 role acceptance is claimed.
The final freeze, independent evaluation, release S-01, live rehearsal and video
remain open. Repository visibility and signed-out public access are not changed
or established by this document.

Original log excerpts are from Loghub BGL and OpenStack, under the dataset
attribution and CC BY 4.0 terms in the [README](../README.md#data). The selected
excerpts retain their original wording. Raw corpus files are not included.
