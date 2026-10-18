# Submission evidence and remaining gates

This tracked directory is the delivery destination for reviewable English
material. Local German planning documents under `docs/` remain outside the
submission. Repository access is unchanged; these files are not a claim that the
private repository or its links are publicly accessible.

| Material | Current evidence | Remaining verification |
|---|---|---|
| Setup, architecture, tools, rules, data attribution and client configuration | [Main README](../README.md), actual shared registry and canonical schemas | Final fresh-clone S-01 against the frozen release, including real model answer, reachable receipts and web export/re-run |
| Engine capabilities | [SereneDB function reference](serenedb-functions.md) and nine complete original JSON receipts under [evidence](evidence/) | Recheck demonstrated paths and versions against the final release; these historical examples are not role acceptance |
| Database timings | [Actual historical SQL report](performance/historical-2026-10-18/report.md), with SQL and source hashes in [JSON](performance/historical-2026-10-18/report.json) | Selected development receipts, mostly one sample per group; no controlled performance or tail-latency claim |
| Independent setup check | [Fresh-clone verification](fresh-clone-check.md), including sample setup, MCP smoke and integration results | Exact final delivery commit, full corpus, actual Claude client and live web S-01 |
| Development evaluation | [LOG-53 implementation and run protocol](../packages/evals/README.md), calibration and offline report replay | Actual predeclared model attempts, independent blinded ratings, human sample and passing development gate; paid model calls are postponed |
| Regression evidence | [S-15 focused rounds](../packages/evals/results/s15-2026-10-18-r5/report.json), including links to earlier failures | Full answer contract and all S-01–S-16 acceptance cases; a focused regression does not establish these |
| Baseline, first holdout and final verification report | Measurement/export/report implementation exists | LOG-54 freeze and LOG-55 first-holdout/client evidence, with all attempts, failures, unknowns and separate quality/runtime/cost metrics; no holdout result is claimed |
| Worked investigation | Known cases and real query evidence are available | Publish one complete English investigation showing all three roles, first assessment, executed discriminating check, its effect and the justified next step; retain unknown causality and business impact |
| Presentation | [Editable Typst template and PDF preview](../presentation/README.md) | Replace placeholders only from verified run artifacts; rehearse the live demo within five minutes and record a labelled English video within three minutes |
| Unknown jury questions | The shared tool registry supports free tool selection | Demonstrate on the frozen client configuration; known development/demo questions are not a holdout |

The live evaluation uses exactly `claude-opus-5-5`. Its saved plan records the
question/tool/instruction/code/data versions, alternating variants, repetitions,
effort controls, context/output/call/time limits and price provenance before paid
execution. The [forecast and execution boundary](../packages/evals/README.md)
distinguish a conservative estimate from a spending cap. No API evaluation is
needed to inspect these documents or replay existing offline reports. Providing
an API key later does not itself establish acceptance.

LOG-56 remains open until the final verification report, worked investigation,
media, client and fresh-clone evidence are complete and all required checks pass.
OTel and optional index/search bonuses do not block the base BGL/OpenStack
submission. If an extension is shipped, its own capabilities and limits need
evidence. No downtime, financial loss, customer effect or proven cause can be
inferred from a log count, an episode, a ranking or a precursor ratio.
