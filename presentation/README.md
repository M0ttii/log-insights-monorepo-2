# Presentation template

An editable English Typst deck for Log Insights. The 16:9 layout uses Urbanist and
the SereneDB colors from `DESIGN.md`. It contains six main slides and three
reserve slides. The checked-in PDF is a **template preview**, not the final
submission: purple `TO FILL` text marks evidence or metadata still to supply.

## Worked-case deck

[Editable worked-case source](worked-investigation.typ) and its
[PDF draft](worked-investigation.pdf) apply the existing layout to the
[English APPREAD investigation](../submission/worked-investigation.md). This
is a known development case, with direct registered tool calls and analyst-written
role views. It contains no new Claude answer or evaluation result. The original
template below remains available.

Build the case deck from the repository root:

```sh
typst compile --root . --font-path presentation/fonts --ignore-system-fonts \
  presentation/worked-investigation.typ presentation/worked-investigation.pdf
```

The root flag allows read-only access to the tracked claim ledger and original
receipt JSON under `submission/`. Displayed figures come from that ledger; a
missing fact stops compilation. The SQL appendix reads a complete executed
statement and its parameters directly from the archived search receipt.
`theme.typ` accepts an optional status footer for this draft.

Six main slides and three reserves retain the template layout. The footer marks
the open evaluation. Link targets use the repository main branch and become
available after merge to authorized readers; public access is not established.
The deck does not replace the missing independent evaluation, final release
verification, live rehearsal or video.

## Build and edit

Use **Typst 0.14.2** (the version used to verify this template). No Typst packages,
Node dependencies, model calls, database access or network requests are needed.
The fonts and their SIL Open Font License are included.

From the repository root:

```sh
typst compile --font-path presentation/fonts --ignore-system-fonts \
  presentation/slides.typ presentation/log-insights-template.pdf
```

For live editing:

```sh
typst watch --font-path presentation/fonts --ignore-system-fonts \
  presentation/slides.typ presentation/log-insights-template.pdf
```

- `settings.typ`: team, date, public links and draft mode.
- `slides.typ`: slide content, empty evidence frames and role-specific layouts.
- `theme.typ`: reusable slide, typography, colors, evidence strip and link helpers.
- `fonts/`: regular, semibold and bold Urbanist TTF instances, derived at weights
  400/600/700 from the design submodule's `Urbanist-Variable.woff2`. The source is
  credited to The Urbanist Project Authors in `fonts/OFL.txt`. No font outlines
  were edited. The static instances keep the PDF reproducible without system fonts
  or an initialized submodule.

Replace each `fill(...)` call with actual content. For a longer SQL excerpt use
Typst's raw code block with the exact executed SQL from a saved receipt. Replace
the empty trend frame with a chart exported from actual `event_trend` results,
retaining the dataset, UTC window, bucket, unit and original fact IDs. The template
deliberately has no invented trend line, corpus count, latency or evaluation score.
Do not publish original log text from memory or rewrite evidence.

Set `deck.draft` to `false` for the final export. Any remaining `fill(...)` or
missing public link then stops compilation with an explicit error. This is a
placeholder guard, not a factual or public-access verifier. Missing team metadata
also triggers the guard. The PDF title loses its template suffix in final mode.

## Story and timing

The main deck has one argument per slide:

1. Cover and question.
2. Approach, system diagram and tool contracts.
3. Query evidence, both datasets and whole-corpus aggregation.
4. Findings and next steps for the engineer, team lead and manager together.
5. Initial hypothesis, executed check and its effect on the recommendation.
6. Limitations and public handoff links.

Detailed SQL/receipts, the full tool catalog and evaluation are reserve slides for
jury questions. The same worked investigation connects the role findings. BGL and
OpenStack receive separate full-span counts and separate time axes.

There is no strict slide limit for this challenge; the organizer's six-slide limit
applies to Camera-based Localization. This deck uses six main slides to leave room
for the working demo. A starting rehearsal budget is 10/30/40/50/30/20 seconds for
slides 1-6 (three minutes in total). Reserve two minutes of the five-minute
presentation/demo allowance for the real workflow or a clearly labelled recording.
Rehearse the actual combined flow. The separate submission video has its own
three-minute limit in the project plan and needs a shorter selection or narration.

## Evidence to fill

Use saved receipts for corpus numbers and query evidence, and saved run/report
artifacts for evaluation metadata. Every analytical number keeps the fact ID
assigned by its tool. Preserve data version, scope, UTC `[start, end)`, filters,
counting units, population and truncation. Whole-corpus aggregation must cover
the full BGL and OpenStack spans, not retrieved examples or the 2k samples.
Keep their time axes separate. Show both retrieval and aggregation for both
datasets, even when the investigation itself focuses on one.

Copy tool descriptions from the current registry when finalizing. The template's
list matches `packages/analytics/src/registry.ts` at creation. It is not generated,
so review it after tool changes. Optional awards and additional datasets require
their own actual evidence and are not claimed in this template.

The main brief describes supplied infrastructure and a loader; the later technical
guidance says to run SereneDB locally and build the schema, loader and fictional
ownership mapping. The architecture slide follows the repository's local setup.
Final setup instructions must describe the real supported clean-checkout path.

## Final public PDF

1. Fill and verify the content, remove template instructions and draft metadata,
   and export a final file such as `presentation/log-insights.pdf`. Recompile after
   every source change and inspect every page for overflow and small text.
2. Publish the final PDF through the normal pull-request workflow. This directory
   is tracked; the repository's local planning `docs/` directory is ignored.
   Export only reviewed evidence needed for the submission from local `.data/`
   into an intentional public submission location. Never publish credentials or
   treat a local receipt path as a jury-accessible link.
3. Confirm the repository is public. A private repository disqualifies the team
   according to the supplied submission information. A restricted PDF receives
   zero points for that section. Committing a PDF to a private repository does
   not satisfy either requirement. The template does not change repo visibility.
4. Set the public repository, investigation and PDF links in `settings.typ`.
   Use stable commit links for evidence. For the PDF, a public GitHub file page
   has the form `https://github.com/OWNER/REPO/blob/COMMIT/presentation/log-insights.pdf`.
   A direct download has the form
   `https://raw.githubusercontent.com/OWNER/REPO/COMMIT/presentation/log-insights.pdf`.
   Recompile, publish and test the actual chosen URL.
5. Open the repository, PDF and every evidence link in a signed-out/private browser.
   Confirm the actual PDF opens or downloads without a login or permission request.
   Paste the verified final PDF URL into the submission form.

This template is the slides preparation part of LOG-56. It does not complete the
investigation, evaluation, clean-checkout proof, recordings or final submission.
