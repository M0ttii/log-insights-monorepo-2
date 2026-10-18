# Actual Claude role examples

These are known demonstration questions and actual model answers, kept separately
from the analyst-written [worked investigation](../worked-investigation.md).
They are selected examples, not a blinded evaluation, current-source quality
certification or proof of the complete client matrix. Original answer text is
preserved; provenance records retain source hashes and complete original receipts in [the evidence directory](../evidence/).

| Role | Actual answer | Source and scope |
|---|---|---|
| Engineer | [Original answer](engineer/answer.md) | [Claude Desktop provenance](engineer/provenance.json); OpenStack token-validation error, original request context, exact frequency, separate full BGL/OpenStack populations and next check |
| Team Lead | [Original answer](team-lead/answer.md) | [Claude Code provenance](team-lead/provenance.json); BGL, Workload Runtime, June 2005; recurrence, weekly trend, missing prior coverage and a concrete team check |
| Manager | [Original answer](manager/answer.md) | [Claude Code provenance](manager/provenance.json); BGL portfolio plus a separately stated recent window; technical investigation order, trade-offs and unknown business impact |

The actual Desktop Engineer answer was captured on 2026-10-18 using the existing
claude.ai subscription, with no Anthropic API call. Its five complete receipts
retain SQL, inputs and results, including the loaded catalog. This is a known
demo, not a holdout or reliability claim. Cause and impact remain unknown; the
second request context was not inspected. Private chat URLs are not published.

The historical Team Lead and Manager probes used `claude-opus-5-5`, guidance 1.0.7, and data version
`dv_229e422f86a9fc6e`. Their exact code commit was not recorded and remains unknown.
They must not be relabelled as current-guidance answers. All referenced facts
resolve to the accompanying complete receipts. Passing submitted claim batches
checks values, metrics and groups only; it does not certify every sentence.

The original tool trace is retained. Its historical harness sometimes recorded a
checked source receipt in the `check_claims` result slot. The actual checker
receipts cited in the answer are included separately and the trace has not been
silently rewritten. Scope dates and identifiers are original response text.

The earlier Engineer parity output and web Team Lead/Manager runs had useful
streamed drafts but no final prose after revision. They remain historical
failures, not successful final answers. The separate client-probe archive retains
other uncited quantities and overbroad causal statements. No missing attempt is
hidden by these selected examples.

Log excerpts and aggregates derive from public Loghub BGL/OpenStack data, Zenodo
record 8196385 (CC BY 4.0). Retain the [dataset attribution](../../README.md#data).
No new paid API evaluation was run to assemble these artifacts.
