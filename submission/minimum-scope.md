# Minimum submission scope and verification

On 2026-10-18 the owner explicitly selected the original challenge minimum and
deferred the additional costly evaluation. This supersedes the earlier internal
A-21/A-23 release gates. It does not turn incomplete experiments into passing ones.

## Required workflow and evidence

- One actual agent answer for Engineer, Team Lead and Manager, with appropriate
  evidence and next actions: [archived examples](agent-examples/README.md).
- Both BGL and OpenStack retrieval and aggregation, full-text search, full loaded
  base-corpus counts, original context and executed checks:
  [worked investigation](worked-investigation.md). Its role views are explicitly
  analyst-written, separate from the model transcripts.
- Accessible SQL, parameters, scope, truncation, results and facts:
  [original receipts](evidence/) and each model example's provenance index.
- Runnable tools and MCP client setup: [main README](../README.md), the earlier
  [independent clean-clone check](fresh-clone-check.md), and the current required
  CI jobs including real SereneDB sample loading and MCP integration. Historical
  checks are not relabelled as tests of a later commit.
- English [slides](../presentation/worked-investigation.pdf) and a short
  [walkthrough script](demo-script.md). Recording/rehearsal status is stated below.

The official challenge brief requires a public repository and a presentation/demo
of at most five minutes. [Participant rules, section 5](https://schubki.com/legal/national-ai-hackathon-2026/rules),
read directly on 2026-10-18, also specify an English demo or walkthrough of at most
three minutes. The general rules permit private jury access; the challenge brief
separately asks for a public repository, so public delivery remains the target.

## Deferred additional research

The baseline/dev trial series, independent ratings and human sample, effort
comparison, holdout freeze/release and first run, complete client/prompt matrix,
and parallel web-role comparison are deferred. The implemented harness is usable
preparation, not evidence that any of these experiments ran or passed. The sealed
holdout remains unopened. There is no baseline advantage, causal improvement,
formal role score, cost benchmark or holdout-performance claim.

Known failed client probes remain under
[client evidence](../packages/evals/results/client-2026-10-18/README.md) and
[S-15 rounds](../packages/evals/results/s15-2026-10-18-r5/report.json).
Earlier web runs marked completed had no final prose after revision; their
completion status is not evidence of a successful final role answer. The core
submission uses the existing MCP client; full live web acceptance is not claimed.

## Delivery status

- Evidence and slides are versioned in this repository.
- Repository is currently private; signed-out access is not established.
- The [English edited walkthrough](../presentation/log-insights-walkthrough.mp4)
  is encoded at 154.424 seconds (under three minutes), with synthetic narration,
  actual answer excerpts and archived query evidence. It is not a live model run.
  A separate live stage rehearsal has not been timed.
- Submission-form upload, roster and deadline freeze remain the team's submission
  action; no unknown portal, legal declaration or organiser message is submitted.

No raw corpus, credentials or private holdout content belongs in the public
package. The bounded original BGL/OpenStack evidence is from the public Loghub
corpus with the attribution and licence in the [README](../README.md#data).
