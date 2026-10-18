# Log Insights presentation

The [edited English walkthrough](log-insights-walkthrough.mp4) is 154.424 seconds,
with synthetic macOS Samantha narration. It shows saved real query evidence,
explicitly analyst-written case views and excerpts from actual Claude answers.
It is not a live model run. [Provenance](walkthrough/manifest.json) retains exact
narration, timing and source hashes. The answer-excerpt card is editable in
[Typst](walkthrough/agent-excerpts.typ), using [original quotations](walkthrough/quotes.json).
The video follows the earlier six-slide story; the five-minute challenge
presentation uses the nine main slides below. A live stage rehearsal has not
been timed.

## Worked-investigation presentation

The [editable Typst deck](worked-investigation.typ) and
[compiled PDF](worked-investigation.pdf) are the challenge pitch, built around the
[English APPREAD investigation](../submission/worked-investigation.md). The deck
has nine main slides and three reserve slides, with Urbanist and the SereneDB
colors from `DESIGN.md`. A web screenshot lives in `assets/`.

Figures come from the checked claim ledger or directly from original receipts
(claim-check totals, database durations, executed SQL, re-run matches); a missing
fact stops compilation. The role slide is labelled as analyst-written views from
real tool calls. The Claude slide quotes [actual answers](../submission/agent-examples/README.md)
from `walkthrough/quotes.json`. OTel figures on the execution slide are the
single local observations recorded in the main README. Neither the case nor the
selected answers is a blinded benchmark; formal baseline, holdout and independent
ratings are deferred and no quality improvement is claimed.

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

1. Title: every number has a receipt; full BGL and OpenStack populations.
2. Why not chat over logs: four failure modes and how the design avoids them.
3. SereneDB does the work: parse, normalize, index and analyze in SQL.
4. Worked case: four queries (search, episodes, context, precursor) change the
   next step.
5. Same case, three roles, three decisions.
6. Actual Claude answers through MCP, with fact IDs.
7. Receipt, `check_claims` mismatch detection and registry re-runs.
8. Clean-clone start, MCP server and remote OTel Parquet at scale.
9. Close and repository link.

The reserve slides contain original SQL, the tool catalog and the stated limits.
The [English narration and action sequence](../submission/demo-script.md) budgets
about 150 seconds for an edited walkthrough of the earlier six-slide story and
archived queries. It must be labelled **Edited walkthrough: archived queries and
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
