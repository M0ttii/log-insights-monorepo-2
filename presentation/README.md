# Log Insights presentation

The [edited English walkthrough](log-insights-walkthrough.mp4) is 154.424 seconds,
with synthetic macOS Samantha narration. It shows saved real query evidence,
explicitly analyst-written case views and excerpts from actual Claude answers.
It is not a live model run. [Provenance](walkthrough/manifest.json) retains exact
narration, timing and source hashes. The answer-excerpt card is editable in
[Typst](walkthrough/agent-excerpts.typ), using [original quotations](walkthrough/quotes.json).
The five-minute challenge presentation can use the six main slides below; a
separate live stage rehearsal has not been timed.

## Worked-investigation presentation

The [editable Typst deck](worked-investigation.typ) and
[compiled PDF](worked-investigation.pdf) present the
[English APPREAD investigation](../submission/worked-investigation.md). The deck
has six main slides and three reserve slides, with Urbanist and the SereneDB
colors from `DESIGN.md`.

This is a known development case: archived real tool calls, original log evidence
and analyst-written role views. The footer says **KNOWN CASE / QUERY EVIDENCE**.
It is not a new Claude answer, a live client test or a model-quality benchmark.
Formal baseline, holdout and independent ratings are deferred optional work; no
quality improvement is claimed. Actual Claude examples are indexed separately in
[the archived agent examples](../submission/agent-examples/README.md).

## Build the worked deck

Use **Typst 0.14.2**. No Typst packages, Node dependencies, model calls, database
access or network requests are needed. Fonts and their SIL Open Font License are
included. From the repository root:

```sh
typst compile --root . --font-path presentation/fonts --ignore-system-fonts \
  presentation/worked-investigation.typ presentation/worked-investigation.pdf
```

The root flag allows read-only access to the tracked claim ledger and original
receipt JSON under `submission/`. Displayed figures come from that ledger; a
missing fact stops compilation. The SQL appendix reads a complete executed
statement and its parameters directly from the archived search receipt.

The worked deck has no template slots and uses its real title and project name.
Its `draft: false` removes the draft PDF metadata; it does not verify repository
visibility, external links, video delivery or final submission. Link targets use
the repository main branch and become available to authorized readers after
merge. Signed-out public access remains to be verified.

## Story and recording

1. Known BGL job-start case and the three roles.
2. Shared registry, SereneDB computation and receipts.
3. Retrieval and full-population aggregation for BGL and OpenStack, on separate
   time axes.
4. Engineer diagnosis, team investigation and manager allocation decisions.
5. Initial hypothesis, executed precursor check and the changed next step.
6. Unknowns and reviewable evidence.

The reserve slides contain original SQL, the tool catalog and verification limits.
The [English narration and action sequence](../submission/demo-script.md) budgets
about 150 seconds for an edited walkthrough of the six main slides and archived
queries. It must be labelled **Edited walkthrough: archived queries and
analyst-written role views**. Actual Claude examples are separate evidence.

The challenge allows at most five minutes for the presentation/demo. The separate
video is limited to three minutes by the
[general submission rules, section 5](https://schubki.com/legal/national-ai-hackathon-2026/rules).
The edited recording is committed and its duration is measured above. A separate
live rehearsal has not been timed; signed-out public access remains unverified.

## Evidence and public access

All analytical figures retain the original tool-assigned fact ID, scope, counting
unit and truncation. Full-span counts cover the loaded BGL and OpenStack base
corpus, not search hits or the 2k samples. The ownership mapping is fictional;
episodes and precursors do not prove incidents, job identity or causes. Unknown
downtime, cost and customer effects remain unknown.

Before submission, merge the reviewed files through the normal PR workflow and
verify the repository, PDF, investigation and receipt URLs while signed out. A
committed PDF in a private repository does not establish public access. No
repository-visibility change or submission upload is performed by this deck.
Use stable commit links for the submitted evidence once the delivery commit is
known. Recompile after source changes and inspect every page for overflow,
legibility and missing glyphs.

## Optional empty template

The original [slides template](slides.typ) remains available for a different
story. It is not the worked deck or the submission PDF. Its `TO FILL` slots are
intentional. Compile it separately:

```sh
typst compile --font-path presentation/fonts --ignore-system-fonts \
  presentation/slides.typ presentation/log-insights-template.pdf
```

- `settings.typ`: template team metadata, public links and draft mode.
- `slides.typ`: template content and empty evidence frames.
- `theme.typ`: shared slide, typography, colors, evidence strip and link helpers.
- `fonts/`: regular, semibold and bold Urbanist TTF instances at weights
  400/600/700, derived from the design submodule's `Urbanist-Variable.woff2`.
  The source is credited to The Urbanist Project Authors in `fonts/OFL.txt`.
  No font outlines were edited; system fonts and the submodule are not needed
  to compile the deck.

For the empty template, replace each `fill(...)` with actual evidence before
setting `deck.draft` to `false`. The guard catches missing slots and metadata;
it does not validate facts or public access. Do not invent a chart, count,
latency, score or original log quotation to fill a frame.
