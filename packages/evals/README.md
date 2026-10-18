# Evaluation workflow

## Submission scope: 2026-10-18

The original challenge requires at least one actual agent answer per role, relevant
retrieval and aggregation on BGL and OpenStack, accessible executed queries and
results, and a runnable submission. It does not require a paid API benchmark.
The owner therefore deferred the formal development/baseline experiment, freeze,
first holdout and optional three-run Web role comparison. These are not submission
gates; the commands below document an optional future experiment and do not
authorize its execution. No paid development round, actual freeze/release or
first-holdout result is claimed. The existing runner and its synthetic controls
remain available.

Submission evidence belongs in the [worked investigation](../../submission/worked-investigation.md)
and the actual role demonstrations linked from the [submission guide](../../submission/README.md).
The investigation's analyst-written role views are not model answers or a formal
eval. The [saved client probes](results/client-2026-10-18/README.md) retain their
known failures; tool connectivity and selected successful checks do not establish
whole-answer correctness or a general quality/pass/improvement claim. Measured
claims still require query evidence, and hypotheses remain distinct from causes.

## Optional formal experiment

LOG-52 supplies the measurement contracts; LOG-53 adds the predeclared development
experiment and blinded independent review workflow. Implementation and synthetic
controls establish no live quality result, baseline advantage, first-holdout result
or formal U16 experiment acceptance. The development bank and existing S-15
rounds are known regression material. LOG-54 adds the separate protected preparation below;
unreleased holdout contents are outside the implementation workspace and context.

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
Before provider execution it also saves `runtime.json` and its complete corpus
receipt, observing the running local Compose image and full base-corpus version.
For the optional experiment, an older round without this runtime evidence cannot
authorize a holdout freeze.
The database call deadline includes connection acquisition and UTC session setup;
stalled setup clients are discarded. Cancelling a pending physical connection
returns to the caller immediately, but pool cleanup can still await pg-pool's
existing 15-second connection-establishment bound because its connect API has no
cancellation operation.

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
an overall quality/cost score. Holdout acceptance remains an optional later
experiment gate. The deferred visible Web comparison is a separate feature, not
submission evidence required by this runner. The committed LOG-52 fixture and
evaluator mutation tests are controls, never measured corpus evidence.

## Protected holdout preparation

Preparation can start before the development gate passes. An independent author
who did not write the playbooks creates at least two new questions per role and
separate assessment expectations. Before release, both remain in a private vault
outside the implementation checkout and its agents' context. The author validates
expectations through independent SereneDB queries, keeps their evidence private
and supplies only an opaque set identifier, role counts, authorship attestation,
data version and file hashes. Authorship declarations are inspectable provenance,
not automated proof of a person's identity or of question quality.

The public registration schema rejects unknown fields. Do not add questions,
concrete entities, filters, expected numbers or private rationale to a ticket,
preparation metadata, PR or implementation prompt. Never inspect the private
files to test registration. Only clearly labelled synthetic questions may be used
for implementation and leak tests.

```sh
# Safe before the gate: reads public metadata only, not private questions.
pnpm eval holdout-register packages/evals/holdouts/MY_SET /private/path/metadata.json

# Later, only after a complete independently reviewed development gate passes:
pnpm eval holdout-freeze .data/evals/MY_SET-freeze \
  packages/evals/holdouts/MY_SET packages/evals/results/PASSED_DEV independent-v1

# Later, after the saved freeze is revalidated; this does not call a model.
pnpm eval holdout-release packages/evals/holdouts/MY_SET \
  .data/evals/MY_SET-freeze /private/path/to/sealed-vault
```

Every output is append-only. Freeze requires the recomputed development report,
not a caller-supplied `passed` flag or edited report JSON. It binds the saved
review, source and lockfile, model and limits, actual instructions for both
variants, tool catalog, rubric, predeclared attempts and pricing provenance.
Runtime evidence binds the actual SereneDB container/image and base-corpus data
version; missing or changed evidence keeps the gate closed. A synthetic fixture
cannot authorize a real freeze. Preparation is neither a freeze nor permission
to run an evaluation.

The [registered set and runtime smoke proof](holdouts/README.md) are preparation
evidence only. The real set remains sealed; a missing development round was
rejected without creating a freeze directory. No actual freeze or release is
claimed.

Release revalidates the frozen configuration before opening private questions.
It checks the source hash, set identifier, role counts and strict public schema,
then serializes the validated public bank afresh as `holdout-<set-id>.yaml` under
`packages/evals/questions`. Comments, anchor names and other YAML source syntax
are not copied. Expectations and independent SQL evidence remain in their
separate private assessment path. The public question projection contains only
question, role and structured scope; it has no expectation, reference or rubric
fields. Distinct hashes bind the sealed source and the actual public output. The
versioned question file is bound separately as release data so its addition does
not disguise unrelated source changes.

Before reading private files, release saves an append-only `release-attempt.json`.
Only after the public file is written and its hash verified does it save the
completed `release.json`. A failed attempt remains visible without claiming
successful publication and requires a fresh independently authored set; do not
delete markers or overwrite the target to retry.

After a real release, commit exactly the released question file as one direct
child of the frozen base commit. A merge, extra commit, changed source, unrelated
file in that commit, dirty public question, unexpected untracked file or changed
public hash blocks the first-holdout executor. Development execution still
requires its original exact commit; the holdout exception is proven by Git
ancestry and the released blob hash before normalizing that one commit for the
frozen configuration comparison.

```sh
# Offline, only after actual freeze/release and the question-only child commit:
pnpm eval holdout-plan packages/evals/results/MY_SET-first \
  packages/evals/holdouts/MY_SET .data/evals/MY_SET-freeze

# Separate explicit paid operation; never run as part of preparation or CI:
pnpm eval holdout-execute packages/evals/results/MY_SET-first

# Safe metadata-only progress, including a consumed round without completion:
pnpm eval holdout-status packages/evals/results/MY_SET-first

# Only after the entire planned round has finished: independent offline review.
pnpm eval prepare-review packages/evals/results/MY_SET-first independent-first-v1
pnpm eval review packages/evals/results/MY_SET-first independent-first-v1 /tmp/holdout-review.json
pnpm eval holdout-report packages/evals/results/MY_SET-first independent-first-v1
```

The saved manifest uses `holdout_first`, the pre-released slot order and both
variants. Its repeated anchors remain in the completed development split; each
holdout slot runs once per variant as frozen in LOG-54. Model, pricing, limits,
instructions and tool catalog come from the frozen development configuration.
Question-only projection metadata gives reviewers the common rubric; sealed
case-specific expectations and independent SQL evidence stay in the author's
separate assessment path and are never passed to `runInvestigation`. The agent
receives only question, role, structured scope, variant and empty history.

Before any model call, execution replays the saved development acceptance,
checks release/source/configuration hashes, observes the current image and corpus,
and writes an append-only first-execution marker in the freeze directory. That
marker binds the set to one round across output directories; failures and aborts
cannot be resumed, replaced or relabelled as another first round. Configuration
is checked again before every planned attempt. Source drift stops the round;
already saved failures and remaining missing attempts stay visible in the report.
No answer stream is printed while the planned attempts run.

`holdout-status` reads only the validated manifest, completion metadata and attempt
metadata. It shows every completed, failed, aborted, missing or invalid slot;
answers, questions, receipts and reviewer files are not opened. Missing completion
is `unconfirmed`, not proof that a process stopped; liveness is not checked. The
status always reports acceptance as `not_demonstrated`. If a process is killed
before recording completion, the consumed first-round marker remains unchanged:
status is still available, while full answer inspection/review stays locked and
no resume or abandonment override is offered.

Core reports and independent review use the same saved receipt/claim checks,
blinded pair orders, calibration and human sample rules as development. The
first pair per role is selected from the frozen role/ordinal slots before answers.
Independent reports are stored under `holdout-reports/`, separate from
`development-reports/`, and carry the split explicitly. The passed development
S-13 gate precedes release; client evidence and the deferred visible Web
comparison remain separate from this formal experiment. A synthetic executor test
establishes none of these real acceptance outcomes. No actual first-holdout round was run for this integration.

If any implementing agent sees unreleased questions or expectations, mark that
set contaminated and replace it through an independent author. Never relabel a
known development/demo question as holdout. After the first actual holdout round,
the inspected set becomes regression material; another generalization claim
requires a fresh independently authored set and freeze. The first answer round
and its acceptance are deferred; closing preparation work does not establish them.
No real freeze, release or paid holdout run is established by synthetic controls or this preparation work.
