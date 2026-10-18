# Evaluation measurement foundation

LOG-52 supplies the runner and offline measurement contracts. It establishes no
live quality result, baseline advantage, first-holdout result or U16 acceptance.
The development questions and existing S-15 rounds are known regression material.

Run from the repository root with Node 24 and pnpm 11.25:

```sh
# Artifact-only fixture; no API key or database required.
pnpm eval fixture /tmp/log52-fixture
pnpm eval report /tmp/log52-fixture

# Explicit paid model execution, using the current loaded data version.
# Requires the normal .env database configuration and ANTHROPIC_API_KEY.
pnpm eval run packages/evals/results/my-development-round --data-version dv_CURRENT

# Save an independent review under a NEW reviewer version.
pnpm eval assess packages/evals/results/my-development-round reviewer-v2 /tmp/assessments.json
pnpm eval report packages/evals/results/my-development-round reviewer-v2
```

`run` calls the production `runInvestigation` for both variants. It predeclares
all paired attempts, repeats one question per role three times per variant,
alternates variant order and starts each attempt with empty history. All eight
tools, common rules, preflight, gate and one revision remain shared; only the
playbook variant receives the coverage follow-ups. The baseline registry receives
simple role guidance before `describe_corpus` writes its receipt. Optional index
tools remain disabled. The shared gate checks frame sections and numbers in both
variants; role-core section feedback is reserved for playbooks so revision cannot
supply the baseline with a role template. Offline product checks still inspect the
full playbook sections. The current model is pinned to `claude-opus-5-5`, effort
`high`, with zero retries and the shared execution limits.

A round contains immutable `manifest.json`, `questions.json`, `attempts/`, exported
`runs/`, `receipts/`, `assessments/<reviewer-version>.json` and
`reports/<reviewer-version>.json`. Every successful tool receipt is copied without
changes, including transitive claims evidence. Hashes detect modified answers and
receipts. Private model history stays in `.data/runs/`; exported records retain
answer versions, inputs, instruction channels, chronology and provider usage.
Interrupted and unsuccessful attempts remain visible. Missing or corrupt required
artifacts prevent a complete measurement and acceptance.

`report` uses only saved artifacts. It never constructs a database connection or
calls a model. `assess` creates a new assessment and report; existing versions
cannot be overwritten. Schema definitions are canonical Zod contracts under
`src/`. Reviewer identity, version and declared independence from playbook authors
are required; this declaration is not automated proof of independence. Reviews
bind to a question and run ID. Unknown review results and missing scope evidence
stay unknown. The review schema is `semanticAssessmentSchema` in `src/evaluate.ts`;
its calibration tests show complete examples.

Numerical values, metrics and groups are judged only by saved `check_claims`
results. The whole answer is also scanned for unchecked citations, uncited numbers
(including zero, small integers, percentages and times) and missing sections. An
independent reviewer assesses final-text claim alignment, scope, required evidence,
top-N generalizations, out-of-span zeros, rate denominators and causal statements.
The recorded tool trace must show the discriminating check before the
recommendation. Syntactic findings do not establish semantic correctness. Routing
controls have their own assessment and are excluded from role-answer means.

Reports show attempt status, elapsed time, actual model/tool calls, provider token
and cache categories, and role/variant summaries. Unknown token fields remain
null. Price provenance and rates can be recorded in the manifest before execution;
without a complete applicable price/usage record costs remain null. Assessment
usage and cost are separate unknown fields until supplied by a reviewer integration.
There is no combined quality/cost score. Three repetitions give median and range,
never a p95 or significance claim. Human spot-checks and S-13 client evidence remain
external gates for the later LOG-53/LOG-55 acceptance.

The committed `results/log52-fixture-v1` is labeled fixture-only. It tests export
and replay and contains no measured corpus results. Controlled numerical and
semantic mutations in `src/evaluate.test.ts` test the evaluator itself, including
valid zero and open-hypothesis controls; they are never demo evidence.
