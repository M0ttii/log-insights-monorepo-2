# Submission evidence

The delivery scope follows the original challenge brief. The owner confirmed on
2026-10-18 that the additional formal evaluation is deferred. This does not change
query correctness, numerical grounding or the distinction between observations,
hypotheses and causes. See the [minimum submission record](minimum-scope.md).

| Required material | Evidence |
|---|---|
| Runnable prototype, setup, architecture and tool contracts | [Main README](../README.md), shared registry, [independent fresh-clone check](fresh-clone-check.md) and required CI with real SereneDB loader/MCP integration |
| Actual agent answers for Engineer, Team Lead and Manager | [Claude examples and provenance](agent-examples/README.md); historical failures remain visible and are not converted into passes |
| BGL and OpenStack retrieval/aggregation, full-corpus populations, evidence and recommendations | [Worked investigation](worked-investigation.md), [manifest](worked-investigation/manifest.json), [checked claims](worked-investigation/claims.json) and complete [original receipts](evidence/) |
| Where SereneDB computes | [Function reference](serenedb-functions.md) with executed SQL paths and original receipts |
| English slides and short walkthrough | [Worked-case deck and source](../presentation/README.md), [154-second edited English walkthrough](../presentation/log-insights-walkthrough.mp4) and [script/provenance](demo-script.md); delivery status in the minimum submission record |
| Known limits and verification | [Minimum submission record](minimum-scope.md), actual client probes, failed attempts, [worked-case verification](worked-investigation/verification.json) and [historical database timing report](performance/historical-2026-10-18/report.md) |

The worked investigation is explicitly analyst-written from real tool calls.
Actual Claude answers have separate source and data-version metadata. Neither is
a blinded quality benchmark. Historical database timings are selected receipt
measurements, not end-to-end model latency or a controlled performance claim.

## Deferred additional research

The [eval harness](../packages/evals/README.md) remains available with its existing
safeguards. The formal baseline/dev experiment, independent ratings and human
sample, freeze/release, first holdout, effort comparison, full client/prompt matrix
and parallel web-role comparison are outside this submission's minimum scope.
They have not been performed or passed. No paid API run is needed to inspect or
replay the saved evidence. Do not infer a quality improvement, holdout score or
production reliability from the harness, CI or selected examples.

The core demonstration uses the existing MCP agent client. Web chat and dataset
extensions are additional capabilities, with their own documented limits; their
complete live model acceptance is not claimed. The original BGL/OpenStack log
excerpts retain Loghub attribution and their original wording. Business impact,
downtime, financial loss and proven initiating causes remain unknown where the
data cannot establish them.
