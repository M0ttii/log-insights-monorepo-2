# Worked-case recording script

This English script accompanies the
[worked-case deck](../presentation/worked-investigation.pdf) and
[investigation](worked-investigation.md). Record it as an **Edited walkthrough:
archived queries and analyst-written role views**. It is not a live Claude answer.
Actual Claude examples are indexed separately in [the archived agent examples](agent-examples/README.md).

The planned narration lasts about 150 seconds at a deliberate speaking pace.
The [edited English recording](../presentation/log-insights-walkthrough.mp4) is
154.424 seconds including actual Claude-answer excerpts. Synthetic narration is
provided by macOS Samantha; this is not a recording of a human voice or a live
model run. [Recording provenance](../presentation/walkthrough/manifest.json)
retains the exact narration, segment timing and source hashes. A separate live
rehearsal has not been timed. All displayed figures
and original quotations come from the linked receipts. Keep their fact IDs
visible; do not add numerical claims from memory.

## English narration and edit sequence

| Planned elapsed time | Slide / action | Narration |
|---|---|---|
| 0:00-0:10 | Case | “Log Insights turns log questions into evidence and a next step for engineers, team leads and managers. This is an edited walkthrough of a known BGL job-start investigation.” |
| 0:10-0:35 | Shared tools; briefly show an archived receipt | “The clients share one tool registry. SereneDB searches and computes; Claude explains in the product. Each tool stores its validated input, exact SQL, parameters, scope and result. This walkthrough uses archived real queries and analyst-written role views. The separate Claude examples show actual client behavior.” |
| 0:35-1:10 | Query evidence; show phrase search and population receipt | “The population queries cover each complete loaded dataset. BGL and OpenStack belong to separate systems and time spans. The BGL phrase search returns original control-stream messages with bounded, truncated hits. A separate aggregation measures the population. The OpenStack example distinguishes API accesses from request identifiers and preserves the original token-validation error.” |
| 1:10-1:50 | Role decisions | “The engineer asks what could distinguish the initiating cause from widespread symptoms. Emitting-node breadth alone cannot locate the origin. The team lead investigates recurring program-image errors and assigns a startup-validation check to a fictional owner. The manager prioritizes investigation by episodes and breadth, with the ranking's trade-offs visible. A large line count alone does not establish priority or business impact.” |
| 1:50-2:15 | Executed check; show precursor receipt | “The initial assessment suspected a systemic job or network event. The executed precursor check found earlier missing-directory evidence, changing the next step toward startup inputs and filesystem availability. That is a temporal association. It does not establish a shared job, a network defect or a proven cause.” |
| 2:15-2:30 | Limits and evidence links | “The initiating cause, downtime and customer effect remain unknown. The shared checker verifies submitted numerical claims, not explanations. Original receipts and the investigation remain reviewable. Formal baseline and holdout evaluation are deferred; this case claims no model-quality improvement.” |

The challenge presentation/demo must fit five minutes. The separate submitted
video must fit three minutes under the
[general rules, section 5](https://schubki.com/legal/national-ai-hackathon-2026/rules).
Time the exported recording and shorten pauses if necessary. The table is a
planning budget, not a statement of observed model runtime.

## Archived-query edit checklist

The complete registry sequence is preserved in the investigation manifest.
For a short recording, show only the selected receipts above; an edited selection
must retain its label. No new model call or formal evaluation is required to
record this walkthrough.

1. `corpus`, `bgl-population`, `openstack-population`: identify the full
   base-corpus snapshot and separate log-event populations. Samples have different
   results and must not be substituted.
2. `appread-search`, then `appread-context`: show the original message,
   truncation flag and signed offsets. Do not infer job identity or per-episode
   synchrony from emitting-node breadth.
3. `appread-precursors`: show the episode-start anchor population, background
   scope and missing-directory association. The result changes the next check,
   not the proven cause.
4. `team-patterns`, `team-trend`, `team-compare`: preserve recurrence,
   unavailable prior-period coverage, partial bucket flags and rest groups.
5. `manager-team-order`, then `manager-order`: distinguish the team
   recommendation from the whole-BGL portfolio and preserve ranking trade-offs.
6. `openstack-latency`, `openstack-search`, `openstack-context`: keep API
   accesses, request IDs and original evidence distinct from BGL.
7. Show the original receipt, a saved matching registry re-run and the archived
   claim-check results. Explain their numerical-only scope. Any new re-run must
   invoke the registered tool with stored validated input, never stored SQL.

A deterministic analyst operation does not demonstrate autonomous tool selection,
model answer quality, web-chat acceptance or complete Claude client compliance.
A saved real client run must be labelled **Recorded run**, with failures and
limits preserved. Database receipt duration is not model waiting time.

Before submission, verify repository, PDF, original receipt and investigation
links while signed out. Recording and public access remain separate delivery
checks; this script does not perform an upload or visibility change.
