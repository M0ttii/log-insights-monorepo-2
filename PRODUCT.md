# Log Insights

<!-- impeccable:product-schema 1 -->

## Platform

web

## Sources of Truth

This is a concise product context record for Impeccable. It summarizes existing decisions; it does not introduce a parallel requirements or UI specification.

- [Product concept](docs/concept.md) v3.4: requirements A-01–A-38, role playbooks, answer contract, rules R-01–R-11, priorities, acceptance cases S-01–S-16, open points. Follows the published challenge brief.
- [UI concept](docs/ui-concept.md) v2.3: navigation (Ask, Overview, Logs, Corpus), role comparison, interactions, states, accessibility, and visual direction.
- [Technical specification](docs/technical.md) v2.5: data model, loader, tool contracts, fact IDs, receipts, MCP server, web chat, verification, work packages and dependencies.
- [Architecture summary](docs/architecture.md): overview; detailed contracts take precedence.
- [Improvements backlog](docs/improvements.md): bonus tracks and deferred features; not requirements.
- [Project conventions](AGENTS.md): implementation conventions and dependency choices.

Keep this summary aligned when those decisions change. Requirements describe the intended product, not evidence that functionality has shipped. The repository contains planning documents, Base UI shadcn primitives in `packages/ui` and configured tooling; there is no app yet. SereneDB setup, tools, MCP server and web chat are not implemented yet.

## Users

Three roles ask about the same base corpus (BGL and OpenStack logs), with different questions and decisions:

- **Engineers** investigate an error: what failed, in which component, and what happened just before and after. They need original messages, nearby events, a labelled possible cause and the next diagnostic check.
- **Team Leads** look for recurring problems: how often, over which period, in which components and teams. They need counts, episodes and trends with the ownership table, and what the team should investigate first.
- **Managers** decide what deserves attention first and what should happen next. They need a short, prioritized list of risks and actions grounded in measured frequency (episodes) and breadth (affected nodes, instances, components), without invented cost, downtime or customer impact.

The jury connects Claude to our MCP server, most likely asking questions without selecting a role prompt, and also watches the web app in the demo.

## Product Purpose

Turn **question → evidence → recommendation** into one checkable workflow. SereneDB searches and computes; Claude selects tools, runs discriminating checks, explains the returned evidence and recommends role-appropriate next steps. Every number in an answer carries a fact ID that points into a query receipt with the exact SQL, parameters, scope, duration and truncation flag.

## Positioning

"SereneDB computes, Claude explains – and every number has a receipt." One tool layer serves Claude through MCP and the web chat, so both give the same numbers. Roles differ in question, evidence, checks, answer structure and action, not only in length; the role comparison shows this side by side. An open hypothesis plus a concrete next check is a valid outcome when logs cannot establish a cause.

## Operating Context

A desktop-first prototype for the SereneDB challenge at the National AI Hackathon 2026, built by the team with several AI coding agents working in parallel during the build period on 17–18 October 2026. It runs locally from a clean checkout of a public repository: SereneDB in Docker, a setup command (`pnpm data:setup`) that downloads and loads the data, an MCP server started by Claude Code or Claude Desktop, and a Next.js web app.

Ask (chat with role switcher, live tool calls and role comparison) is the primary area. Overview shows corpus facts without AI, Logs provides direct search and context, Corpus explains datasets, schema, ownership and rules. Conversations live in the browser session; receipts persist as JSON files in `.data/receipts/`.

## Capabilities and Constraints

- Eight tools: `describe_corpus`, `search_logs` (BM25 full-text with terms, phrase and fuzzy modes and time filters), `get_log_context` (one event, or precursors across all episodes of a pattern), `count_events` (with period comparison), `event_trend`, `recurring_patterns` (with investigation order for managers), `latency_stats` (OpenStack), `check_claims`. Optional index tools only behind a flag.
- Frequencies come from aggregations over the stated scope, never from search hits. Results are bounded and say when they are truncated.
- BGL (2005–2006) and OpenStack (2017) share no time axis; trends are per dataset. The ownership table is fictional; unmapped components are `unowned`.
- Observations, hypotheses and proven causes remain distinct. Matches and episodes are not incidents. Business impact is unknown without business data.
- No free SQL from the agent, no production changes, no autonomous fixes or tickets. Logs and model output are untrusted content.
- UTC is the visible default; time ranges include their start and exclude their end. UI, code and submission are English.
- Manager priorities rank by episodes and breadth, not by log-line volume, and name trade-offs instead of using a composite risk score.
- P0 is the brief's minimum plus receipts, claim check, MCP server, all eight tools, role guidance without a prompt and discriminating checks. The web app is P1 and never blocks P0.

## Brand Commitments

The working name is **Log Insights**. Communication is precise, understandable and explicit about evidence and uncertainty. The interface uses the SereneDB desktop app look from the SereneDB design kit: dark by default with a full light theme, Urbanist, the SereneDB violet as the only accent, restrained and exact (DESIGN.md).

**Component foundation (binding):** The interface is built only from shadcn components, blocks and AI Elements patterns in their Base UI variant (`@base-ui/react`, style `base-nova`). Every UI task starts with the shadcn MCP. Where shadcn offers a component, block or pattern, it is used; no hand-built replacements in raw HTML and Tailwind. The chat uses AI Elements with `useChat` and streamed message parts, following [docs/ui-concept.md](docs/ui-concept.md) § 10; assistant-ui, Radix and other chat runtimes are excluded. Charts use the shadcn `chart` component. Details and enforced rules are in [AGENTS.md](AGENTS.md).

## Evidence on Hand

The repository contains planning documents and tooling only. No query has run against the real corpus yet. Examples in the documents describe intended behavior, not verified findings.

Planned verification compares simple role guidance with full playbooks under equal conditions, using independently authored holdout questions released after a configuration freeze. The first holdout round is reported separately; inspected questions become regression tests. Predeclared repeated trials report quality, total duration, calls, tokens and estimated API costs from saved run artifacts, including failures. Product corpus claims still require receipts. The comparison need not show a playbook win; a separate experiment on historical evidence remains optional (I-21). See concept A-21 and technical.md § 13.

Do not fabricate benchmarks, business impact, live results or completed acceptance checks. Synthetic fixtures must be labelled. A recorded demo must be identified as a recording.

## Product Principles

1. Every number has a receipt; every claim is inspectable.
2. The database computes, the model explains.
3. Roles differ in question, evidence and action.
4. State uncertainty and data limitations rather than filling gaps.
5. Make the tool calls visible; leave decisions with people.

## Accessibility & Inclusion

Support keyboard operation, visible focus, accessible names, associated errors and sensible focus return. Status must include text rather than color alone. Charts require equivalent tables, and motion must respect reduced-motion preferences.

Verify the desktop workspace at 1280 × 800 and 1920 × 1080. Narrower layouts must preserve accessible actions; long evidence and SQL scroll within their panel. Preserve input on failures and the reading position during streaming.

## Open Decisions

The product concept's O-01–O-07 list the open points: Anthropic API access for the web chat, SereneDB function support confirmed in the compatibility gate, local SereneDB instead of a provided instance, the OpenStack anomaly label format, disclosure of work prepared before the build window, whether OpenStack contains 5xx accesses at all, and the observed BGL severity levels.
