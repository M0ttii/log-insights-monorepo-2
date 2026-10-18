---
name: Log Insights
description: A calm, exact AI SRE workspace where every number leads to its receipt.
colors:
  trail-indigo: "#5654d6"
  trail-indigo-deep: "#4543b5"
  trail-indigo-wash: "#eeedfc"
  on-indigo: "#ffffff"
  workspace-ground: "#f7f8fa"
  surface: "#ffffff"
  slate-ink: "#202635"
  slate-secondary: "#596579"
  quiet-fill: "#f1f3f6"
  secondary-fill: "#eef0f4"
  divider: "#dfe3ea"
  sidebar-divider: "#e6e9ef"
  control-border: "#858fa1"
  spine-line: "#c3c9d4"
  conclusion-wash: "#f5f5fe"
  conclusion-border: "#d9d8f6"
  selection: "#deddf8"
  match-highlight: "#fdf0c2"
  destructive: "oklch(0.577 0.245 27.325)"
  severity-fatal-fg: "#861b27"
  severity-fatal-bg: "#fce7eb"
  severity-error-fg: "#a12b36"
  severity-error-bg: "#fff0f1"
  severity-warning-fg: "#855000"
  severity-warning-bg: "#fff3d9"
  severity-info-fg: "#315d89"
  severity-info-bg: "#edf4fc"
  severity-unknown-fg: "#596579"
  severity-unknown-bg: "#edf0f4"
  run-running-fg: "#4543b5"
  run-running-bg: "#eeedfc"
  run-partial-fg: "#855000"
  run-partial-bg: "#fff3d9"
  run-failed-fg: "#a12b36"
  run-failed-bg: "#fff0f1"
  run-neutral-fg: "#596579"
  run-neutral-bg: "#edf0f4"
  hypothesis-open-fg: "#596579"
  hypothesis-open-bg: "#ffffff"
  hypothesis-supported-fg: "#ffffff"
  hypothesis-supported-bg: "#475569"
  hypothesis-contradicted-fg: "#475569"
  hypothesis-contradicted-bg: "#e8edf2"
  pattern-new-fg: "#4543b5"
  pattern-new-bg: "#ffffff"
  pattern-escalating-fg: "#805314"
  pattern-escalating-bg: "#fff0d8"
  pattern-reappeared-fg: "#475569"
  pattern-reappeared-bg: "#edf0f4"
  pattern-ongoing-fg: "#475569"
  pattern-ongoing-bg: "#edf0f4"
  pattern-quiet-fg: "#596579"
  pattern-quiet-bg: "#f3f4f6"
  pattern-recurring-fg: "#475569"
  pattern-recurring-bg: "#ffffff"
  change-fg: "#475569"
  change-bg: "#edf0f4"
  verification-verified-fg: "#28634a"
  verification-verified-bg: "#eaf5ee"
  verification-mismatch-fg: "#a12b36"
  verification-mismatch-bg: "#fff0f1"
  verification-unresolved-fg: "#855000"
  verification-unresolved-bg: "#fff3d9"
  verification-unchecked-fg: "#596579"
  verification-unchecked-bg: "#edf0f4"
  verification-uncited-fg: "#855000"
  verification-uncited-bg: "#ffffff"
  verification-none-fg: "#596579"
  verification-none-bg: "#edf0f4"
  role-fg: "#202635"
  role-bg: "#ffffff"
typography:
  headline:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 600
    lineHeight: "2rem"
    letterSpacing: "-0.025em"
    fontFeature: "tnum"
  title:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 600
    lineHeight: "1.5rem"
    fontFeature: "tnum"
  metric:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 600
    lineHeight: "1.75rem"
    fontFeature: "tnum"
  body-report:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: "1.75rem"
    fontFeature: "tnum"
  body:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: "1.5rem"
    fontFeature: "tnum"
  label:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 500
    lineHeight: "1rem"
    fontFeature: "tnum"
  mono:
    fontFamily: "Geist Mono, ui-monospace, SFMono-Regular, monospace"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: "1.25rem"
rounded:
  sm: "6px"
  md: "8px"
  lg: "10px"
  xl: "14px"
  pill: "9999px"
spacing:
  hairline: "4px"
  tight: "8px"
  block: "16px"
  gutter: "24px"
  section: "40px"
  spine: "48px"
components:
  button-primary:
    backgroundColor: "{colors.trail-indigo}"
    textColor: "{colors.on-indigo}"
    rounded: "{rounded.lg}"
    padding: "0 10px"
    height: "32px"
    typography: "{typography.body}"
  button-outline:
    backgroundColor: "{colors.workspace-ground}"
    textColor: "{colors.slate-ink}"
    rounded: "{rounded.lg}"
    padding: "0 10px"
    height: "28px"
  button-outline-hover:
    backgroundColor: "{colors.quiet-fill}"
  button-ghost:
    textColor: "{colors.slate-ink}"
    rounded: "{rounded.lg}"
    padding: "0 10px"
    height: "28px"
  button-ghost-hover:
    backgroundColor: "{colors.quiet-fill}"
  card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.slate-ink}"
    rounded: "{rounded.xl}"
    padding: "16px"
  input:
    textColor: "{colors.slate-ink}"
    rounded: "{rounded.lg}"
    padding: "4px 10px"
    height: "32px"
  status-badge:
    rounded: "{rounded.pill}"
    padding: "2px 8px"
    height: "20px"
    typography: "{typography.label}"
  fact-chip:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.slate-ink}"
    rounded: "{rounded.md}"
    padding: "0 6px"
    height: "22px"
    typography: "{typography.mono}"
  feature-chip:
    backgroundColor: "{colors.quiet-fill}"
    textColor: "{colors.slate-secondary}"
    rounded: "{rounded.sm}"
    padding: "0 6px"
    height: "20px"
    typography: "{typography.label}"
  nav-item-active:
    backgroundColor: "{colors.trail-indigo-wash}"
    textColor: "{colors.trail-indigo-deep}"
    rounded: "{rounded.md}"
    height: "36px"
  header-bar:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.slate-ink}"
    height: "56px"
    padding: "0 12px"
  verification-block:
    backgroundColor: "{colors.conclusion-wash}"
    textColor: "{colors.slate-ink}"
    rounded: "{rounded.xl}"
    padding: "8px 20px"
---

# Design System: Log Insights

Structure, flows and states come from [ui-concept.md](docs/ui-concept.md) (v3.0). This file defines how they look. The token values live once in `packages/ui/src/styles/globals.css`; the names below match it (`fg`/`bg` here, `-foreground`/`-background` there).

## Overview

**Creative North Star: "The Evidence Trail"**

Log Insights is a light, quiet working surface for people who must defend what they conclude. Every answer is a trail: a role asks a question, tool calls run in SereneDB, their receipts carry the numbers, the answer cites those numbers, and the trail ends at the check of what was cited. The design makes that path visible and keeps every number one action away from its receipt. Nothing on screen should look like a finding unless it can point to an event or a tool result.

The system is restrained and exact. Hierarchy comes from type weight, spacing and alignment, not from colour fields or ornament. One accent, Trail Indigo, marks where the path goes: the primary action, the focus ring, the active navigation item, a running step and the terminal node of an answer. Status colour is semantic and split into separate families, so that "supported" can never read as "proven", an escalating pattern can never read as an error, and a verified number can never read as a verified explanation. Density follows the task: answers read as a calm single column; tool results and data views widen and tighten into tables.

The workspace is Operate-mode product UI built from shadcn/ui on Base UI (`base-nova`) with the AI Elements patterns. Its character lives in precise details, such as tabular numerals everywhere, Geist Mono for identifiers and fact IDs, the tool trace and the answer spine, rather than in custom primitives.

**Key Characteristics:**
- One cool, light ground with white working surfaces and slate ink.
- A single indigo accent reserved for path, focus, selection and running work.
- Independent status token families, always icon + text + colour.
- Answers hung on a vertical spine that ends in a filled Trail Indigo node at Verification.
- Monospaced fact-ID chips beside every number, with their verification state.
- The UI formats values; it never computes them.
- Flat at rest; shadows only for overlays.

## Colors

A cool, near-neutral slate palette with one saturated indigo accent and a strictly semantic set of status pairs.

### Primary
- **Trail Indigo** (`trail-indigo`): primary buttons, the focus ring (`--ring`), caret colour, links in prose and the filled terminal node of the answer spine. It means "this is the path" or "act here".
- **Deep Trail Indigo** (`trail-indigo-deep`): text on indigo-tinted surfaces, namely the active sidebar item, the running state and the `new` pattern status. It keeps indigo legible at small sizes.
- **Indigo Wash** (`trail-indigo-wash`): background of navigation items on hover and when active, and of the running badge. It is never used as a general decorative fill.

### Neutral
- **Workspace Ground** (`workspace-ground`): the page background behind all content. It is cool and very light, so white surfaces separate from it without borders shouting.
- **Paper White** (`surface`): cards, the sidebar, the header bar, the Evidence Drawer and menus.
- **Slate Ink** (`slate-ink`): all primary text, including card, popover and sidebar foregrounds. There is exactly one near-black.
- **Slate Secondary** (`slate-secondary`): descriptions, metadata, captions and table timestamps. It meets 4.5:1 on Paper White, Workspace Ground and Quiet Fill.
- **Quiet Fill** (`quiet-fill`): limitation notes, SQL and JSON wells, SereneDB feature chips and hover backgrounds for ghost and outline buttons.
- **Secondary Fill** (`secondary-fill`): the secondary badge (for example the `Recorded run` banner) and secondary buttons.
- **Hairline** (`divider`) and **Sidebar Hairline** (`sidebar-divider`): decorative dividers between rows, table lines and card rings. They are decorative only, at about 1.3:1.
- **Control Border** (`control-border`): outlines of inputs and unfilled controls (≥3:1), and the ring of unfilled spine nodes.
- **Spine Line** (`spine-line`): the vertical line connecting tool rows and answer sections. It is darker than Hairline so the trail stays visible on Workspace Ground.
- **Conclusion Wash** and **Conclusion Edge** (`conclusion-wash`, `conclusion-border`): the only indigo-tinted content surface. It is reserved for the Verification block of an answer and for the highlighted target: the anchor event in a context timeline and the fact a chip opened in the drawer.
- **Selection** (`selection`): text selection background, paired with Slate Ink.
- **Match Highlight** (`match-highlight`): background of search matches inside verbatim log messages, always with an underline, never the only cue.

### Status families
Each family is a foreground/background pair with its own icon set and text label (see Components → Status badge). Value sets follow ui-concept.md § 9 and the tool contracts.
- **Severity** (`severity-*`): levels as logged. Red and amber appear only for error and warning levels (`FATAL`, `FAILURE`, `SEVERE`, `CRITICAL`, `ERROR`; `WARNING`). Unknown is neutral.
- **Run state** (`run-*`): one family for tool rows and answers. Running and streaming in indigo; stopped and partial in amber; failed and tool errors in red; done and recorded share the neutral pair (`run-neutral-*`). A finished tool call is not a success claim and is never green.
- **Hypothesis status** (`hypothesis-*`): slate only. Open is an outline, supported is filled slate, and contradicted uses a struck icon on pale slate.
- **Pattern status** (`pattern-*`, R-10): `new` is an indigo outline and `escalating` a warm ochre; `reappeared` and `ongoing` are neutral with distinct icons; `quiet` is the lightest neutral. The `recurring` flag (R-05) is a separate outline badge that can sit beside any status.
- **Change** (`change-*`, R-06): one neutral pair for the comparison labels `significantly increased`, `first observed in this comparison` and `not observed in either period`, distinguished by icon and text. An increase is not red.
- **Verification** (`verification-*`): `verified` in calm green, `mismatch` in red, `unresolved` in amber, `unchecked` neutral, `uncited` as an amber dotted underline on white, `not verified` (`verification-none-*`) neutral. Verified describes value, metric and group of a submitted number, never the explanation.
- **Role** (`role-*`): an outlined neutral badge for Engineer, Team Lead and Manager. Roles never take a status or severity colour.

### Named Rules
**The One Trail Rule.** Trail Indigo marks the path, focus, selection and running work only. It never fills a decorative area, a heading or a chart series by default.

**The Separate Meanings Rule.** A status token carries exactly one meaning. Never reuse a severity colour for a pattern status, a verification colour for a hypothesis, or a run colour for a check result. Supported is not proven; contradicted is a valuable finding, not an error; verified is about a number, not an argument.

**The Unknown Is Not Fine Rule.** Missing values, `null` results, undeterminable breadth or base rates, capture gaps and unknown severity render neutral and are labelled in words ("Unknown", "not determinable", "no data captured"). They are never shown as zero or as complete.

**The Formatting Is Not Computing Rule.** Thousands separators, units, a ratio shown as a percentage and UTC formatting are allowed. A sum, difference, share, rank or re-sorted list that no tool returned is not.

## Typography

**Body Font:** Geist (with ui-sans-serif, system-ui)
**Mono Font:** Geist Mono (with ui-monospace)

**Character:** One well-tuned sans carries everything from page titles to table cells; Geist Mono appears only where the text is data: fact and receipt IDs, signatures, event IDs, nodes, request IDs, patterns, log messages, SQL and JSON. All numerals are tabular, globally.

### Hierarchy
- **Headline** (600, 1.5rem, 2rem line height, −0.025em): the page title (h1), one per view. Balanced wrapping.
- **Title** (600, 1rem, 1.5rem): section headings (h2), answer section labels and card titles.
- **Metric** (600, 1.25rem, 1.75rem): the current value in the comparison block and the headline value of an Overview tile. Nowhere else.
- **Body (report)** (400, 1rem, 1.75rem): answer prose. The measure is capped at about 65ch (`max-w-prose`).
- **Body** (400, 0.875rem, 1.5rem): descriptions, table content, tool-row summaries and limitations.
- **Label** (500, 0.75rem, 1rem): badges, metadata rows, captions, feature chips and the scope bar.
- **Mono** (400, 0.75rem): IDs, nodes, patterns, log messages, SQL, parameters and JSON.

### Named Rules
**The Mono Is Data Rule.** Geist Mono is used only for values a person might copy, compare or search: IDs, signatures, nodes, patterns, raw messages, SQL and JSON. It is never a "technical" costume for labels or headings.

**The Tabular Everywhere Rule.** `font-variant-numeric: tabular-nums` is set on `body`. Timestamps, counts and deltas must align in columns without per-component overrides.

## Layout

The shell is a 16rem shadcn Sidebar (collapsible to an icon rail) beside a column that holds a 56px header bar and a scrolling workspace. Content sits on Workspace Ground with a 24px side gutter (16px on phones), 32px above the page title and 64px of trailing space.

Pages pick one of two widths. Reading views (Ask answers, Corpus) are centred at **53.75rem**, the report column. Data views (Overview, Logs, the role comparison and expanded tool results) widen to **76rem**. The Evidence Drawer is **32rem** wide and overlays the workspace rather than squeezing it; SQL and wide result tables scroll inside it.

The vertical rhythm is deliberate rather than uniform:
- 40px between the page header and each top-level section.
- 48px between spine sections in an answer.
- 16px between a section heading and its content.
- 12px between sibling cards and between tool rows.
- 12–14px row padding inside lists and tables.

The header bar keeps scope readable at the mandatory 1280 × 800 size: corpus size with its fact chips, data version and the Open receipt field stay visible. Below `lg` the version labels drop and remain on the Corpus page. The scope bar above the composer shows dataset, `[from, to)` in UTC and a compact filter summary; full labels and removal actions sit in its popover. Tables never cause page overflow; they scroll inside their card. Long messages keep a minimum column width and scroll within their panel instead of wrapping one character per line.

**The Two Widths Rule.** Prose is held to the report column and data gets the data column. Never stretch an answer to fill a 1920px screen, and never cap a dense table at report width.

## Elevation & Depth

The system is flat and tonal. Depth at rest comes from white surfaces on the cool ground plus a 1px ring at about 10% of Slate Ink. Shadows exist only on things that float above the workspace.

### Shadow Vocabulary
- **Composer lift** (`box-shadow: 0 1px 2px 0 rgb(0 0 0 / 0.05)`): the single resting exception, which marks the question input as the place to start.
- **Overlay** (`box-shadow: 0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)`): the Evidence Drawer, dropdown menus, hover cards and tooltips.

### Named Rules
**The Flat At Rest Rule.** Cards, tables, tool rows, the Verification block and the header bar carry no shadow. If something needs to stand out, give it weight, space or the Conclusion Wash, not a shadow.

## Shapes

Corners are moderate and consistent: 6px on feature chips, 8px on fact chips and nav items, 10px on buttons and inputs, and 14px on cards and the Verification block. Status badges are fully rounded pills. Spine nodes are 12px circles: hollow with a Control Border ring for intermediate steps, filled Trail Indigo with a soft 4px indigo halo for the terminal Verification node.

Borders are hairlines. Rows inside a card are separated by 1px dividers rather than split into separate cards.

## Components

### Buttons
Quiet until needed.
- **Shape:** gently rounded (10px). Heights are 32px for default and 28px for `sm` and icon `sm`.
- **Primary:** Trail Indigo fill with white text, hover at 80% opacity. Use one per view at most (Send, Re-run).
- **Outline:** a Hairline border on the ground colour that fills with Quiet Fill on hover. It is used for per-item actions such as `Ask as Team Lead`, `Export run` or `Precursors of this pattern`.
- **Ghost:** transparent and fills with Quiet Fill on hover. It is used in the header bar and for row-level disclosure.
- **Focus / active:** a 3px Trail Indigo ring at 50% plus the global 2px outline with 3px offset. Pressed buttons shift down 1px.

### Status badge
The system's most important component. Its colour encodes meaning, and it is never the only carrier of that meaning.
- **Style:** a 20px pill with a 12px Lucide icon and a text label, drawn from the family's foreground/background pair.
- **Outline variants:** hypothesis `open`, pattern `new`, the `recurring` flag and the role badge use a `currentColor` border on a white fill.
- **Rule:** a badge always has icon + text. A new status needs a new token pair, not a borrowed one.

### Fact chip
A citation, not a link dump. The model writes value, unit and fact ID; the app turns the ID into a chip.
- **Style:** a compact, focusable chip after the number with the full fact ID (`r_7f3a9c21.f4`) in Geist Mono, so it can be compared with the same ID in Claude Desktop, and a 12px state icon from the Verification family. A receipt chip (`r_7f3a9c21`) has the same shape without a fact suffix.
- **States:** verified, mismatch (the preview names `value`, `metric` or `group`), unresolved, unchecked. An unresolved chip keeps its identity and opens no invented content.
- **Accessible name:** "Fact r_7f3a9c21.f4, verified, open evidence".
- **Hover:** a Base UI hover card previews value, metric, unit, group and receipt scope; clicking or pressing Enter opens the drawer at that fact without relying on hover.
- **Shared numbers:** in the role comparison, chips of tool calls with the same receipt signature carry the same letter marker (Ⓐ, Ⓑ …).

### Uncited mark
A dotted underline in `verification-uncited-fg` under a number or time that has no fact chip next to it, with a 12px icon after it. It is focusable and explains itself ("No fact ID next to this number"). It marks, it does not judge: the number may still be right.

### Tool row (trace)
One line per tool call on the spine, from the AI Elements `Trace` pattern: tool name in Mono, the mode in plain words ("precursor analysis"), a one-line input summary in Body, the run-state badge, "SereneDB 41 ms" in Label, the receipt chip and up to three feature chips. Expanding a row reveals the tool's result view and its validated input. A `check_claims` row shows its summary with its own fact chips.

### Feature chip
A 20px Quiet Fill chip in Label type naming a SereneDB function found in the receipt's SQL (`BM25 ranking`, `Phrase search`, `Row pattern matching`, `Percentiles` …), with a tooltip that explains what the function did. It never appears without the function in the SQL.

### Cards / Containers
- **Corner style:** 14px.
- **Background:** Paper White with a 1px ring at about 10% Slate Ink. There is no shadow.
- **Internal padding:** 16px. Lists inside a card use divided rows instead of nested cards.
- **Use:** cards hold standalone interactive or tabular content (result views, Overview tiles, the composer). Answer prose sits directly on the ground.

### Inputs / Fields
- **Style:** a 1px Control Border at 10px radius on a transparent fill, Slate Ink text and Slate Secondary placeholder. The composer variant is borderless inside a card with the Composer lift.
- **Focus:** the border becomes Trail Indigo with a 3px Trail Indigo ring at 50%.
- **Disabled:** cursor not-allowed. A disabled control is always paired with a visible sentence explaining why (for example "Chat unavailable: no model configured").

### Navigation
- **Sidebar:** Paper White with four items (Ask, Overview, Logs, Corpus). The brand mark is a 24px Trail Indigo tile with a white icon.
- **States:** items are 36px high. Hover and active both fill with Indigo Wash; the active item adds Deep Trail Indigo text, medium weight and `aria-current="page"`.
- **Collapsed:** a 48px icon rail in which every item keeps a tooltip and its accessible name.
- **Mobile:** the sidebar becomes a sheet that closes on selection and on Escape.

### Header bar
A single 56px line on Paper White with a Hairline bottom border. It holds the sidebar trigger; the corpus size per dataset with fact chips and "UTC"; data, contract and playbook versions in Label; and the **Open receipt** field, which accepts a receipt or fact ID and opens the drawer.

### Scope bar
A Label-sized line above the composer: dataset, `[from, to)` in UTC and a filter summary, or `Scope: chosen by the agent`. Filters a new role cannot use carry a `not applied` badge and a remove action.

### Answer spine (signature)
The Evidence Trail made literal. Tool rows and the answer's recognised sections hang on a 1px Spine Line, each with a 12px node aligned to its heading, in the order the model wrote them. Only the Verification node is filled Trail Indigo, and the line stops there. An outline beside the answer lists the sections and names missing required ones in Slate Secondary ("Missing section: Next check"); the text itself is never reordered.

### Verification block
The only Conclusion Wash surface in an answer: a 14px-radius container with a Conclusion Edge border. It holds one line per `check_claims` call ("22 checked · 0 mismatch · 0 unresolved" with fact chips), never a sum across calls, or `not verified`. A second, visibly separate line lists the app's markings (unchecked fact IDs, uncited numbers). Stopped or partial answers show `Partial answer – not verified` instead.

### Comparison block
One line on Paper White inside a 1px Hairline, 10px radius, filled only from `count_events` with `compare`:
- the current value C in Metric type with its counting unit;
- "vs" the baseline value B and its named UTC window;
- `delta` and `pct_change` as returned, and the R-06 change badge;
- the fact chips, aligned right.

### Charts
One clear series per meaning, named units and buckets, and an equivalent table. Observed zeros sit on the zero line. Partial buckets are hatched and labelled; capture gaps break the line and are labelled "no data captured"; ranges outside the data span stay empty. Series colours are neutral slates by default; indigo only for the focused series.

### Log message
Verbatim text in Geist Mono inside a Quiet Fill well, never rendered as HTML. Matches from `match_ranges` use `mark` with Match Highlight and an underline. A cut message ends in "(cut)".

## Do's and Don'ts

### Do:
- **Do** put a fact chip next to every number and time in an answer, and show the fact behind every value in a result view on focus.
- **Do** keep status as icon + text + colour from its own token family.
- **Do** render all times in UTC through the shared formatter. Windows read "4 Jun 2005 · 10:00–11:00 UTC", with the start included and the end excluded.
- **Do** show SereneDB's work at the receipt: duration, population with its counting unit, and the feature chips.
- **Do** separate rows inside one card with Hairline dividers instead of stacking many small cards.
- **Do** use Geist Mono only for IDs, nodes, patterns, messages, SQL and JSON.
- **Do** show unknown or missing values as a labelled neutral ("Unknown", "not determinable"), never as zero or blank.

### Don't:
- **Don't** compute, sum, re-rank or re-sort tool results in the UI.
- **Don't** use green for supported or red for contradicted. Hypothesis status stays slate.
- **Don't** colour a pattern status or an increase like a severity. Escalating is ochre, not error red.
- **Don't** show a composite score or colour priorities by rank.
- **Don't** put a shadow on resting cards, tables, tool rows or the Verification block.
- **Don't** wrap every paragraph in a card. Answers are prose on the ground; cards are for interactive or tabular content.
- **Don't** use Trail Indigo for decoration, headings or large fills.
- **Don't** add eyebrow labels above headings or numbered section markers. The spine and the heading carry the structure.
- **Don't** hand-build controls that shadcn (Base UI, `base-nova`) or AI Elements provide.
