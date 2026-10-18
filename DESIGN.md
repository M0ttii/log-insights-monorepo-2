---
name: Log Insights
description: The SereneDB console look for evidence work, where every number leads to its receipt.
colors:
  serene-violet: "#895af8"
  action-violet: "#6f48cb"
  action-hover: "#5838a3"
  on-violet: "#ffffff"
  console-ground: "#1c1c1c"
  console-surface: "#212121"
  console-rail: "#151515"
  console-rail-hover: "#2a2a2a"
  console-muted: "#2e2e2e"
  console-ink: "#ffffff"
  console-secondary: "oklch(0.707 0.022 261.325)"
  console-secondary-text: "#bbbbbb"
  console-hover: "#313131"
  console-border: "oklch(1 0 0 / 10%)"
  console-control-border: "#6b6b6b"
  console-link: "#b59cff"
  paper-ground: "#ffffff"
  paper-rail: "#f0f2f5"
  paper-muted: "#f0f2f5"
  paper-ink: "#11121d"
  paper-secondary: "#506182"
  paper-border: "#e7e7e7"
  paper-control-border: "#858fa1"
  paper-link: "#6a3fd6"
  destructive: "oklch(0.704 0.191 22.216)"
  spine-line: "#474747"
  conclusion-wash: "#241f33"
  conclusion-border: "#3f3463"
  match-highlight: "#4d3f0f"
  chart-1: "#895af8"
  chart-2: "#80beff"
  chart-3: "#2ec4d6"
  chart-4: "#ff5fa2"
  chart-5: "#5d7cff"
  severity-fatal-fg: "#ffb3bf"
  severity-fatal-bg: "#3d1a20"
  severity-error-fg: "#ff9aa8"
  severity-error-bg: "#35191d"
  severity-warning-fg: "#f5c66b"
  severity-warning-bg: "#33270f"
  severity-info-fg: "#9cc7f5"
  severity-info-bg: "#172636"
  severity-unknown-fg: "#b4b9c4"
  severity-unknown-bg: "#2a2b2e"
  run-running-fg: "#c4b1ff"
  run-running-bg: "#2c2346"
  run-partial-fg: "#f5c66b"
  run-partial-bg: "#33270f"
  run-failed-fg: "#ff9aa8"
  run-failed-bg: "#35191d"
  run-neutral-fg: "#b4b9c4"
  run-neutral-bg: "#2a2b2e"
  hypothesis-open-fg: "#c7cbd3"
  hypothesis-open-bg: "#212121"
  hypothesis-supported-fg: "#1c1c1c"
  hypothesis-supported-bg: "#c7cbd3"
  hypothesis-contradicted-fg: "#c7cbd3"
  hypothesis-contradicted-bg: "#2f3237"
  pattern-new-fg: "#c4b1ff"
  pattern-new-bg: "#212121"
  pattern-escalating-fg: "#f0c07a"
  pattern-escalating-bg: "#35280f"
  pattern-reappeared-fg: "#c7cbd3"
  pattern-reappeared-bg: "#2f3237"
  pattern-ongoing-fg: "#c7cbd3"
  pattern-ongoing-bg: "#2f3237"
  pattern-quiet-fg: "#a3a8b2"
  pattern-quiet-bg: "#262626"
  pattern-recurring-fg: "#c7cbd3"
  pattern-recurring-bg: "#212121"
  change-fg: "#c7cbd3"
  change-bg: "#2f3237"
  verification-verified-fg: "#8fd9ad"
  verification-verified-bg: "#16301f"
  verification-mismatch-fg: "#ff9aa8"
  verification-mismatch-bg: "#35191d"
  verification-unresolved-fg: "#f5c66b"
  verification-unresolved-bg: "#33270f"
  verification-unchecked-fg: "#b4b9c4"
  verification-unchecked-bg: "#2a2b2e"
  verification-uncited-fg: "#f5c66b"
  verification-uncited-bg: "#212121"
  verification-none-fg: "#b4b9c4"
  verification-none-bg: "#2a2b2e"
  role-fg: "#ffffff"
  role-bg: "#212121"
typography:
  headline:
    fontFamily: "Urbanist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 600
    lineHeight: "2rem"
    letterSpacing: "-0.02em"
    fontFeature: "tnum"
  title:
    fontFamily: "Urbanist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 600
    lineHeight: "1.5rem"
    fontFeature: "tnum"
  metric:
    fontFamily: "Urbanist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 600
    lineHeight: "1.75rem"
    fontFeature: "tnum"
  body-report:
    fontFamily: "Urbanist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: "1.75rem"
    fontFeature: "tnum"
  body:
    fontFamily: "Urbanist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: "1.5rem"
    fontFeature: "tnum"
  label:
    fontFamily: "Urbanist, ui-sans-serif, system-ui, sans-serif"
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
  sm: "3.6px"
  md: "4.8px"
  lg: "6px"
  xl: "8.4px"
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
    backgroundColor: "{colors.action-violet}"
    textColor: "{colors.on-violet}"
    rounded: "{rounded.lg}"
    padding: "0 12px"
    height: "32px"
    typography: "{typography.body}"
  button-secondary:
    backgroundColor: "{colors.console-surface}"
    textColor: "{colors.console-secondary-text}"
    rounded: "{rounded.lg}"
    padding: "0 10px"
    height: "28px"
  button-ghost-hover:
    backgroundColor: "{colors.console-muted}"
  card:
    backgroundColor: "{colors.console-surface}"
    textColor: "{colors.console-ink}"
    rounded: "{rounded.xl}"
    padding: "16px"
  input:
    textColor: "{colors.console-ink}"
    rounded: "{rounded.lg}"
    padding: "4px 10px"
    height: "32px"
  status-badge:
    rounded: "{rounded.pill}"
    padding: "2px 8px"
    height: "20px"
    typography: "{typography.label}"
  fact-chip:
    backgroundColor: "{colors.console-surface}"
    textColor: "{colors.console-ink}"
    rounded: "{rounded.md}"
    padding: "0 6px"
    height: "22px"
    typography: "{typography.mono}"
  feature-chip:
    backgroundColor: "{colors.console-muted}"
    textColor: "{colors.console-secondary}"
    rounded: "{rounded.sm}"
    padding: "0 6px"
    height: "20px"
    typography: "{typography.label}"
  nav-item-active:
    backgroundColor: "{colors.console-rail-hover}"
    textColor: "{colors.console-ink}"
    rounded: "{rounded.md}"
    height: "36px"
  header-bar:
    backgroundColor: "{colors.console-ground}"
    textColor: "{colors.console-ink}"
    height: "56px"
    padding: "0 12px"
  verification-block:
    backgroundColor: "{colors.conclusion-wash}"
    textColor: "{colors.console-ink}"
    rounded: "{rounded.xl}"
    padding: "8px 20px"
---

# Design System: Log Insights

Structure, flows and states come from [ui-concept.md](docs/ui-concept.md) (v3.0). This file defines how they look. The front matter lists the **dark** theme, which is the default; light values for the core neutrals carry the `paper-` prefix, and every light status pair sits next to its dark one in `packages/ui/src/styles/globals.css` (`fg`/`bg` here, `-foreground`/`-background` there). That file is the only place token values are set.

## Source: the SereneDB design kit

The look is the one of the SereneDB desktop app and console: a dark, quiet working surface, Urbanist type, the SereneDB violet as the only brand colour, hairline borders and slightly rounded controls. Its palette and font come from the SereneDB design kit [`serenedb/serene-design`](https://github.com/serenedb/serene-design), included as a git submodule at `vendor/serene-design` and pinned to one commit.

- **Used:** `src/styles/tokens.css` (palette, light on `:root`, dark under `.dark`) and `src/styles/fonts.css` (Urbanist, SIL OFL 1.1), both imported by `globals.css` before our layer.
- **Not used:** the kit's `theme.css` (it forces square corners and brings its own base layer) and its React components (`Button`, `Select`, `Popover`, `PlatformHeader`, `ThemeProvider`), because they build on Radix. Primitives stay shadcn on Base UI (`base-nova`).
- **Mapping:** two kit names mean something else than in shadcn. The kit's `--primary` is the neutral surface and `--thirdly` is the SereneDB violet, so shadcn's `primary` reads `--action`. The kit's `--accent` is a blue whose foreground is the same blue, so shadcn's `accent` (hover and selected rows) reads `--surface-hover`. The kit's dark `--muted` is darker than the ground (it is the rail), while shadcn uses `muted` for hover fills and raised wells, so shadcn's `muted` reads `--surface-muted`, raised above the ground in dark; the rail keeps the kit value through `--sidebar`. Secondary text, control borders, links, sidebar and all status families are our layer on top of the kit.
- **Updating:** `git submodule update --remote vendor/serene-design` moves the pin; commit the pointer on its own, naming the kit change, and rerun the contrast check of this file's status pairs. `pnpm install` initialises the submodule, CI checks it out recursively, and `vendor/` is excluded from Prettier, oxlint and knip.

## Overview

**Creative North Star: "The Evidence Trail, in the SereneDB console"**

Log Insights looks like a part of SereneDB, not like a separate tool. Every answer is a trail: a role asks a question, tool calls run in SereneDB, their receipts carry the numbers, the answer cites those numbers, and the trail ends at the check of what was cited. The console look keeps that trail calm: a near-black ground, slightly lighter working surfaces, white ink and one violet that marks where the path goes.

The system is restrained and exact. Hierarchy comes from type weight, spacing and the step between ground, surface and rail, not from colour fields or ornament. Serene Violet marks the primary action, the focus ring, selection, running work and the terminal node of an answer. Status colour is semantic and split into separate families, so that "supported" can never read as "proven", an escalating pattern can never read as an error, and a verified number can never read as a verified explanation. Density follows the task: answers read as a calm single column; tool results and data views widen and tighten into tables.

**Key Characteristics:**
- Dark by default, light on request; both from the kit's palette.
- Three dark steps: rail `#151515`, ground `#1c1c1c`, surface `#212121`, separated by 10% white hairlines.
- A single violet accent reserved for path, focus, selection and running work.
- Urbanist for the interface, Geist Mono for data.
- Independent status token families, always icon + text + colour, with a checked pair per theme.
- Answers hung on a vertical spine that ends in a filled violet node at Verification.
- The UI formats values; it never computes them.
- Flat at rest; shadows only for overlays.

## Colors

The kit's neutral console palette with one saturated violet accent and a strictly semantic set of status pairs.

### Theme
Dark is the default because the SereneDB desktop app and console are dark and the demo runs next to them. The theme is a `.dark` class on `<html>`, as in the kit; the web app renders it on the first response and offers a light/dark toggle whose choice is remembered per browser. Light is a complete theme, not an inversion: every pair below has a light counterpart that meets the same contrast.

### Primary
- **Serene Violet** (`serene-violet`, kit `--thirdly`): focus ring, caret, selection tint, the terminal spine node, the first chart series and the logo tile. It means "this is the path" or "act here".
- **Action Violet** (`action-violet`, `--action`): the fill of primary buttons, the violet deepened 14% toward black in OKLab so white text reaches 6:1 in both themes.
- **Action Hover** (`action-hover`, `--action-hover`, utility `bg-primary-hover`): the primary fill on hover, a further 15% darker. Hover darkens instead of fading, because an 80% alpha fade over a white ground drops white text below 4.5:1.
- **Violet text** (`console-link` / `paper-link`): links in answer prose and the `running` and `new` badges; lighter in dark, deeper in light, so text on the ground clears 4.5:1.

### Neutral
- **Console Ground** (`console-ground`, kit `--background`): the page behind all content.
- **Console Surface** (`console-surface`, kit `--card`): cards, popovers, the Evidence Drawer, tool results.
- **Console Rail** (`console-rail`, kit `--muted`, via `--sidebar`): the sidebar and icon rail, one step darker than the ground, as in the desktop app. Its hover and active fill is **Rail Hover** (`console-rail-hover`, `--sidebar-accent`).
- **Muted** (`console-muted` / `paper-muted`, `--surface-muted`, shadcn `muted`): raised wells for SQL and log messages, feature chips, tab lists, skeletons, and the hover fill of ghost buttons and table rows (half strength in dark, as shadcn's own dark theme does). Raised above the ground in dark; the kit's light muted in light.
- **Console Ink** (`console-ink`): primary text. There is exactly one ink per theme.
- **Console Secondary** (`console-secondary`, kit `--muted-foreground`): descriptions, metadata, captions, timestamps. At least 4.5:1 on ground, surface and rail.
- **Console Hover** (`console-hover`, `--surface-hover`): hover and selected rows, the active navigation item.
- **Hairline** (`console-border`, kit `--border`): dividers, table lines, card rings. Decorative only.
- **Control Border** (`console-control-border`, `--control-border`): outlines of inputs and unfilled controls, at least 3:1 on ground and surface. The kit's own input colour is too faint for that; this is the one deliberate deviation from it.
- **Spine Line** (`spine-line`): the vertical line connecting tool rows and answer sections, visible on the ground without competing with text.
- **Conclusion Wash** and **Conclusion Edge** (`conclusion-wash`, `conclusion-border`): the only violet-tinted content surface, reserved for the Verification block and for the highlighted target (the anchor event in a context timeline, the fact a chip opened in the drawer).
- **Match Highlight** (`match-highlight`): background of search matches in verbatim log messages, always with an underline.

### Charts
The kit's chart palette (`chart-1` violet, `chart-2` blue, `chart-3` cyan, `chart-4` pink, `chart-5` indigo) colours up to five named series in order; `other` is always Console Secondary. A single-series chart uses `chart-1`. Series never borrow a status colour.

### Status families
Each family is a foreground/background pair with its own icon set and text label (see Components → Status badge). Value sets follow ui-concept.md § 9 and the tool contracts.
- **Severity** (`severity-*`): levels as logged. Red and amber appear only for error and warning levels (`FATAL`, `FAILURE`, `SEVERE`, `CRITICAL`, `ERROR`; `WARNING`). Unknown is neutral.
- **Run state** (`run-*`): one family for tool rows and answers. Running and streaming in violet; stopped and partial in amber; failed and tool errors in red; done and recorded share the neutral pair. A finished tool call is not a success claim and is never green.
- **Hypothesis status** (`hypothesis-*`): slate only. Open is an outline, supported is filled slate, contradicted uses a struck icon on dark slate.
- **Pattern status** (`pattern-*`, R-10): `new` is a violet outline and `escalating` a warm ochre; `reappeared` and `ongoing` are neutral with distinct icons; `quiet` is the faintest neutral. The `recurring` flag (R-05) is a separate outline badge beside any status.
- **Change** (`change-*`, R-06): one neutral pair for the comparison labels, distinguished by icon and text. An increase is not red.
- **Verification** (`verification-*`): `verified` in calm green, `mismatch` in red, `unresolved` in amber, `unchecked` neutral, `uncited` as an amber dotted underline, `not verified` (`verification-none-*`) neutral. Verified describes value, metric and group of a submitted number, never the explanation.
- **Role** (`role-*`): an outlined neutral badge for Engineer, Team Lead and Manager.

### Named Rules
**The One Violet Rule.** Serene Violet marks the path, focus, selection and running work only. It never fills a decorative area, a heading or a large field. The kit's blue `accent` and marketing gradients are not used in the product.

**The Separate Meanings Rule.** A status token carries exactly one meaning. Never reuse a severity colour for a pattern status, a verification colour for a hypothesis, or a run colour for a check result. Supported is not proven; contradicted is a valuable finding, not an error; verified is about a number, not an argument.

**The Unknown Is Not Fine Rule.** Missing values, `null` results, undeterminable breadth or base rates, capture gaps and unknown severity render neutral and are labelled in words ("Unknown", "not determinable", "no data captured"). They are never shown as zero or as complete.

**The Formatting Is Not Computing Rule.** Thousands separators, units, a ratio shown as a percentage and UTC formatting are allowed. A sum, difference, share, rank or re-sorted list that no tool returned is not.

**The Both Themes Rule.** A new token is a pair for dark and light, checked for contrast in both before it ships.

## Typography

**Body Font:** Urbanist (self-hosted from the kit, variable 100–900)
**Mono Font:** Geist Mono (from `next/font` in the web app as `--font-geist-mono`; the system mono stack until it loads)

**Character:** Urbanist carries the whole interface, as in every SereneDB front end; its geometric, open forms keep dense tables readable on a dark ground. Geist Mono appears only where the text is data: fact and receipt IDs, signatures, event IDs, nodes, request IDs, patterns, log messages, SQL and JSON. The kit names no mono face; Geist Mono is ours because IDs must stay unambiguous (`0`/`O`, `1`/`l`). All numerals are tabular, globally.

### Hierarchy
- **Headline** (600, 1.5rem, 2rem line height, −0.02em): the page title (h1), one per view. Balanced wrapping.
- **Title** (600, 1rem, 1.5rem): section headings (h2), answer section labels and card titles.
- **Metric** (600, 1.25rem, 1.75rem): the current value in the comparison block and the headline value of an Overview tile. Nowhere else.
- **Body (report)** (400, 1rem, 1.75rem): answer prose, at most about 65ch.
- **Body** (400, 0.875rem, 1.5rem): descriptions, table content, tool-row summaries and limitations.
- **Label** (500, 0.75rem, 1rem): badges, metadata rows, captions, feature chips and the scope bar.
- **Mono** (400, 0.75rem): IDs, nodes, patterns, log messages, SQL, parameters and JSON.

### Named Rules
**The Mono Is Data Rule.** Geist Mono is used only for values a person might copy, compare or search. It is never a "technical" costume for labels or headings.

**The Tabular Everywhere Rule.** `font-variant-numeric: tabular-nums` is set on `body`. Timestamps, counts and deltas align in columns without per-component overrides.

## Layout

The shell follows the SereneDB desktop app: a narrow icon rail and a 16rem shadcn Sidebar (collapsible to the rail) on Console Rail, beside a column that holds a 56px header bar and a scrolling workspace on Console Ground. Content has a 24px side gutter (16px on phones), 32px above the page title and 64px of trailing space. The primary action of a view sits at the bottom right of its work area, where the desktop app puts `Run`.

Pages pick one of two widths. Reading views (Ask answers, Corpus) are centred at **53.75rem**. Data views (Overview, Logs, the role comparison and expanded tool results) widen to **76rem**. The Evidence Drawer is **32rem** wide and overlays the workspace; SQL and wide result tables scroll inside it.

The vertical rhythm is deliberate rather than uniform:
- 40px between the page header and each top-level section.
- 48px between spine sections in an answer.
- 16px between a section heading and its content.
- 12px between sibling cards and between tool rows.
- 12–14px row padding inside lists and tables.

The header bar keeps scope readable at the mandatory 1280 × 800 size: corpus size with its fact chips, data version and the Open receipt field, centred like the desktop app's connection field. Below `lg` the version labels drop and remain on the Corpus page. The scope bar above the composer shows dataset, `[from, to)` in UTC and a compact filter summary. Tables never cause page overflow; they scroll inside their card. Long messages keep a minimum column width and scroll within their panel.

**The Two Widths Rule.** Prose is held to the reading column and data gets the data column.

## Elevation & Depth

The system is flat and tonal. Depth comes from the three neutral steps (rail, ground, surface) and 10% hairlines, not from shadows.

### Shadow Vocabulary
- **Overlay** (`box-shadow: 0 10px 15px -3px rgb(0 0 0 / 0.35), 0 4px 6px -4px rgb(0 0 0 / 0.35)`): the Evidence Drawer, dialogs, dropdown menus, hover cards and tooltips, plus a dimmed scrim behind modal overlays as in the desktop app's connection dialog. Light theme uses the same offsets at 10%.

### Named Rules
**The Flat At Rest Rule.** Cards, tables, tool rows, the composer, the Verification block and the header bar carry no shadow. If something must stand out, give it weight, space or the Conclusion Wash.

## Shapes

Slightly rounded like the desktop app, not square like the kit's marketing sites: `--radius` is 6px, so small chips are about 3.6px, fact chips and nav items 4.8px, buttons and inputs 6px, and cards, dialogs and the Verification block 8.4px. Status badges are fully rounded pills. Spine nodes are 12px circles: hollow with a Control Border ring for intermediate steps, filled Serene Violet with a soft violet halo for the terminal Verification node.

Borders are hairlines. Rows inside a card are separated by dividers rather than split into separate cards.

## Components

### Buttons
Quiet until needed.
- **Shape:** 6px corners. Heights are 32px for default and 28px for `sm` and icon `sm`.
- **Primary:** Action Violet fill with white text, Action Hover on hover. One per view at most (Send, Run, Re-run), placed at the bottom right of its area.
- **Secondary:** Console Surface fill (kit `--secondary`) with Console Secondary Text, 5% lighter toward ink on hover (`Ask as Team Lead`, `Export run`, `Test`-style actions).
- **Ghost:** transparent, Muted on hover (half strength in dark); used in the header bar and for row-level disclosure. Navigation items use Rail Hover instead.
- **Link:** violet text (`text-link`: `console-link` / `paper-link`), never `text-primary`, which is a fill colour and falls below 4.5:1 as text on the dark ground.
- **Focus / active:** shadcn components draw a 3px Serene Violet ring at 50% and suppress the outline; every other focusable element gets the global 2px violet outline with 3px offset.

### Status badge
The system's most important component. Its colour encodes meaning, and it is never the only carrier of that meaning.
- **Style:** a 20px pill with a 12px Lucide icon and a text label, drawn from the family's pair for the current theme.
- **Outline variants:** hypothesis `open`, pattern `new`, the `recurring` flag and the role badge use a `currentColor` border on the surface.
- **Rule:** a badge always has icon + text. A new status needs a new token pair in both themes.

### Fact chip
A citation, not a link dump. The model writes value, unit and fact ID; the app turns the ID into a chip.
- **Style:** a compact, focusable chip after the number with the full fact ID (`r_7f3a9c21.f4`) in Geist Mono on Console Surface with a hairline, plus a 12px state icon from the Verification family.
- **States:** verified, mismatch (the preview names `value`, `metric` or `group`), unresolved, unchecked. An unresolved chip keeps its identity and opens no invented content.
- **Accessible name:** "Fact r_7f3a9c21.f4, verified, open evidence".
- **Hover:** a Base UI hover card previews value, metric, unit, group and receipt scope; Enter or click opens the drawer at that fact.
- **Shared numbers:** in the role comparison, chips of tool calls with the same receipt signature carry the same letter marker (Ⓐ, Ⓑ …).

### Uncited mark
A dotted underline in `verification-uncited-fg` under a number or time without a fact chip next to it, with a 12px icon after it. It is focusable and explains itself ("No fact ID next to this number"). It marks, it does not judge.

### Tool row (trace)
Tool calls for an answer version sit inside a shared disclosure, closed by default. Its compact summary shows the number of calls and their execution status, including running, failed and interrupted calls. Opening it reveals the original ordered tool rows and evidence requests; it never runs a tool again. Each answer version keeps the user's disclosure choice while streaming or moving into the draft. The answer and its per-call Verification summaries remain visible outside the disclosure.

One line per tool call on the spine, from the AI Elements `Trace` pattern: tool name in Mono, the mode in plain words ("precursor analysis"), a one-line input summary, the run-state badge, "SereneDB 41 ms" in Label, the receipt chip and up to three feature chips. Expanding a row reveals the tool's result view and its validated input. A `check_claims` row shows its summary with its own fact chips.

### Feature chip
A 20px Muted chip in Label type naming a SereneDB function found in the receipt's SQL (`BM25 ranking`, `Phrase search`, `Row pattern matching`, `Percentiles` …), with a tooltip that explains what the function did. It never appears without the function in the SQL.

### Cards / Containers
- **Corner style:** 8.4px.
- **Background:** Console Surface with a hairline ring; no shadow.
- **Internal padding:** 16px. Lists inside a card use divided rows instead of nested cards.
- **Use:** cards hold standalone interactive or tabular content (result views, Overview tiles). Answer prose sits directly on the ground.

### Inputs / Fields
- **Style:** a 1px Control Border at 6px radius on a faint fill of the same colour, as in the desktop app's connection form, with ink text and Console Secondary placeholder. The composer sits in a card on the ground.
- **Focus:** the border becomes Serene Violet with a 3px violet ring at 50%.
- **Disabled:** cursor not-allowed, paired with a visible sentence explaining why (for example "Chat unavailable: no model configured").

### Navigation
- **Rail and sidebar:** Console Rail with the 26px violet logo tile at the top, then Ask, Overview, Logs and Corpus; theme toggle and help at the bottom, as in the desktop app.
- **States:** items are 36px high. Hover and active fill with Rail Hover; the active item adds ink text, medium weight and `aria-current="page"`.
- **Collapsed:** the icon rail, in which every item keeps a tooltip and its accessible name.
- **Mobile:** the sidebar becomes a sheet that closes on selection and on Escape.

### Header bar
A single 56px line on Console Ground with a hairline bottom border, like the desktop app's title bar: the sidebar trigger, the view name in Label caps, the centred **Open receipt** field (accepts a receipt or fact ID and opens the drawer), corpus size with fact chips, data, contract and playbook versions in Label.

### Scope bar
A Label-sized line above the composer: dataset, `[from, to)` in UTC and a filter summary, or `Scope: chosen by the agent`. Filters a new role cannot use carry a `not applied` badge and a remove action.

### Answer spine (signature)
The Evidence Trail made literal. Tool rows and the answer's recognised sections hang on a 1px Spine Line, each with a 12px node aligned to its heading, in the order the model wrote them. Only the Verification node is filled Serene Violet, and the line stops there. An outline beside the answer lists the sections and names missing required ones in Console Secondary ("Missing section: Next check"); the text itself is never reordered.

### Verification block
The only Conclusion Wash surface in an answer: an 8.4px-radius container with a Conclusion Edge border. It holds one line per `check_claims` call ("22 checked · 0 mismatch · 0 unresolved" with fact chips), never a sum across calls, or `not verified`. A second, visibly separate line lists the app's markings (unchecked fact IDs, uncited numbers). Stopped or partial answers show `Partial answer – not verified` instead.

### Comparison block
One line on Console Surface inside a hairline, filled only from `count_events` with `compare`: the current value C in Metric type with its counting unit; "vs" the baseline value B and its named UTC window; `delta` and `pct_change` as returned, and the R-06 change badge; the fact chips, aligned right.

### Charts
One clear series per meaning from the kit's chart palette, named units and buckets, and an equivalent table. Observed zeros sit on the zero line. Partial buckets are hatched and labelled; capture gaps break the line and are labelled "no data captured"; ranges outside the data span stay empty. Grid lines use the kit's `--grid-line`.

### Log message and SQL
Verbatim text in Geist Mono in a Muted well, never rendered as HTML. Matches from `match_ranges` use `mark` with Match Highlight and an underline. A cut message ends in "(cut)". SQL in the drawer uses the same well with line numbers in Console Secondary, like the desktop app's query editor.

## Do's and Don'ts

### Do:
- **Do** put a fact chip next to every number and time in an answer, and show the fact behind every value in a result view on focus.
- **Do** keep status as icon + text + colour from its own token family, with a pair for each theme.
- **Do** render all times in UTC through the shared formatter. Windows read "4 Jun 2005 · 10:00–11:00 UTC", with the start included and the end excluded.
- **Do** show SereneDB's work at the receipt: duration, population with its counting unit, and the feature chips.
- **Do** take palette and font from the kit and add only what the kit has no answer for (status families, control borders, links).
- **Do** use Geist Mono only for IDs, nodes, patterns, messages, SQL and JSON.
- **Do** show unknown or missing values as a labelled neutral, never as zero or blank.

### Don't:
- **Don't** compute, sum, re-rank or re-sort tool results in the UI.
- **Don't** import the kit's `theme.css` or React components, or override kit tokens with a different meaning.
- **Don't** use the kit's blue `accent`, marketing gradients, ASCII frames or planet artwork in the product.
- **Don't** use green for supported or red for contradicted. Hypothesis status stays slate.
- **Don't** colour a pattern status or an increase like a severity. Escalating is ochre, not error red.
- **Don't** show a composite score or colour priorities by rank.
- **Don't** put a shadow on resting cards, tables, tool rows or the Verification block.
- **Don't** wrap every paragraph in a card. Answers are prose on the ground; cards are for interactive or tabular content.
- **Don't** add eyebrow labels above headings or numbered section markers.
- **Don't** hand-build controls that shadcn (Base UI, `base-nova`) or AI Elements provide.
