# Development evaluation

LOG-52 supplies the measurement contracts; LOG-53 adds the predeclared development
experiment and blinded independent review workflow. Implementation and synthetic
controls establish no live quality result, baseline advantage, first-holdout result
or U16 acceptance. The development bank and existing S-15 rounds are known
regression material. Holdout questions are outside this workflow.

Run from the repository root with Node 24 and pnpm 11.25:

```sh
# Artifact-only fixture, without an API key or database.
pnpm eval fixture /tmp/log53-fixture
pnpm eval report /tmp/log53-fixture

# Offline preparation, without credentials or external calls.
pnpm eval plan packages/evals/results/my-development-round --data-version dv_CURRENT

# Later: explicit paid execution of that exact saved plan.
# Requires .env database configuration and ANTHROPIC_API_KEY.
pnpm eval execute packages/evals/results/my-development-round

# Prepare offline reviewer packets and keep private-review/ from reviewers.
pnpm eval prepare-review packages/evals/results/my-development-round independent-v1

# Import independent and human judgments; replay without external access.
pnpm eval review packages/evals/results/my-development-round independent-v1 /tmp/review-input.json
pnpm eval development-report packages/evals/results/my-development-round independent-v1

# Existing semantic-only review and replay remain available.
pnpm eval assess packages/evals/results/my-development-round reviewer-v2 /tmp/assessments.json
pnpm eval report packages/evals/results/my-development-round reviewer-v2
```

The default plan contains 46 role-comparison attempts: the known development bank,
three S-13 questions with identical text and structured scope across roles, and
three repetitions of `dev-eng-01`, `dev-tl-01`, `dev-mgr-01` in each variant.
Twelve additional attempts compare effort `high` and `medium` on those same three
known cases in both variants. They are separate configuration controls, excluded
from role-comparison means and repetition summaries. High remains the production
default. New configurations need a new round; failures cannot be replaced or
resumed in place. `run` prepares and immediately executes a new round.

Both variants allow 16 actual provider calls per attempt, 4,096 output tokens per
call, 262,144 UTF-8 bytes of normalized provider input per call, and 180 seconds
per attempt. Middleware enforces input and call bounds before the provider is
invoked, including accumulated tool output. The byte guard is not an exact
provider token counter. Preflight must match the manifest's data version before
any paid request. Execution verifies source, prompt, catalog, question, model and
limit hashes; an append-only execution marker prevents repeating a saved round.

The manifest records pricing provenance, the one-hour cache policy, planned
answer/reviewer calls, output limits, a conservative input-token forecast and the
sequential time bound before execution. The checked USD price snapshot is
[Anthropic's pricing table](https://platform.claude.com/docs/en/about-claude/pricing),
2026-10-18: input 4, output 20, cache read 0.20 and one-hour cache write 8 per
million tokens. The forecast prices all input at cache-write rates and one token
per serialized byte. It is deliberately conservative, not a spending cap or an
exact provider-token bound. Actual costs use reported usage; unknown values stay
null. Reviewers may work offline; reviewer API pricing and usage stay unknown
unless explicitly supplied. No paid evaluation was run for this change.

`runInvestigation` executes both variants with identical eight tools, common
rules, preflight, gate and one revision. Only role guidance and coverage differ.
Baseline guidance is selected before `describe_corpus` writes its receipt; role
section feedback is reserved for playbooks so revision cannot supply the baseline
with a template. Product checks still inspect full playbook sections. Optional
index tools remain disabled. Every attempt starts with empty history; the plan
alternates variant order. The model is exactly `claude-opus-5-5`, with effort
`high` in the role comparison and no retries.

Round artifacts are append-only: `manifest.json`, `questions.json`, `attempts/`,
`runs/`, `receipts/`, `assessments/` and `reports/`. Export copies complete original
receipts unchanged, including transitive claims evidence. Hashes detect modified
answers and evidence. Private model history stays in `.data/runs/`; exported
records retain answer versions, chronology and provider usage. Errors, aborts,
missing artifacts and unknown measurements remain visible.

Independent reviewers must not have authored the playbooks or know their rationale.
Reviewer packets hide variant labels, instruction texts and guidance while keeping
full answers and factual evidence. The reviewer view of `describe_corpus` omits
only `answer_guidance` and `guidance_version`, records those omissions and binds to
the unchanged original receipt hash. Every analytical fact, result, scope,
population and truncation field remains available. This projection is never
represented as the original receipt or its result digest. Other prompt-bearing
receipts and oversized/missing evidence cause review errors, never truncated
positive judgments. Answer style can still reveal variants; blinding is imperfect.

The five content dimensions score 0–2 with reasons: scope, relevant evidence,
action with team/object, decision-changing check/information, and causal separation.
Headings and fixed tool sequences earn no content bonus. Full playbook product
conformance remains a separate check. Saved `check_claims` results alone establish
number/value/metric/group correctness. Semantics also inspect top-N claims,
out-of-span zeros, denominators, precursor causality and claim alignment; a tool
call alone does not establish a successful discriminating check.

Before rating real answers, every independent reviewer calibrates on the complete
synthetic LOG-52 controls supplied in `calibration/<version>.json`. These include
wrong values/metrics/groups, invalid scope and status, valid zero/open hypotheses
and check chronology. The imported calibration binds reviewer identity/version
to that source hash and records every judgment with a reason. Missing, incorrect
or stale calibration keeps acceptance open. This attestation and declared
independence are inspectable reviewer evidence, not automated proof of identity.

The review-input JSON has arrays `judge_submissions`, `pair_judgments`,
`human_reviews`, `s13_content` and `calibrations`. Their canonical Zod contracts are
in `judging.ts`, `comparison.ts` and `calibration.ts`. Copy identifiers and hashes
from the saved packets exactly. `private-review/<version>.json` holds variant
mappings and the sample policy; only the corresponding public packets go to
independent reviewers. Save new preparation/review versions for corrections;
existing originals cannot be overwritten.

Pair preferences run in both answer orders. Only consistent winners count; ties,
order disagreements, unknowns, missing pairs and denominators remain separate.
The human sample is predeclared: the first repetition of one anchor pair per role,
all critical scope/causality findings and all order disagreements. Human reviews
retain the original judgment and any reasoned correction. S-13 checks identical
structured scope/data version, equal results for equal normalized tool inputs and
independent evidence of the three role-specific decisions. Unknown gates keep
acceptance open; preference wins never replace rubric/product thresholds.

Reports use saved JSON only, without DB/provider access. Reviewer versions cannot
be overwritten. Original LOG-52 fixture reports have their original evaluator
hash: to re-evaluate them with changed code, save a new reviewer version. Reports
separate role comparison and effort controls, numerical/scope errors, rubric
dimensions, duration, calls, token/cache usage and estimated costs. Repeated trials
retain individual values and median/min/max with n, without p95, significance or
an overall quality/cost score. Holdout and visible Web S-13 acceptance remain later
gates. The committed LOG-52 fixture and evaluator mutation tests are controls,
never measured corpus evidence.
