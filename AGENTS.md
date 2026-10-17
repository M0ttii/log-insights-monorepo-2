# Log Insights conventions

Log Insights turns the BGL and OpenStack log corpus into **question → evidence →
recommendation** for three roles: a tool layer on SereneDB, exposed through an MCP
server (P0) and a web chat (P1). SereneDB searches and computes; Claude explains and
recommends; every number has a query receipt. `apps/` stays empty until `apps/mcp`
and `apps/web` get their first real code; the registry in `packages/analytics` is
the list of tools that exist.

## Sources of truth

Planning docs in `docs/` are German; read only the sections relevant to a change:

1. [concept.md](docs/concept.md): requirements A-01–A-38, role playbooks, answer
   contract, rules R-01–R-11, priorities, acceptance cases S-01–S-16. It follows the
   published challenge brief, which wins on conflict.
2. [technical.md](docs/technical.md): data model, loader, tool contracts, fact IDs,
   receipts, MCP server, web chat, verification, work packages U01–U21 (§ 14).
3. [ui-concept.md](docs/ui-concept.md): authoritative for UI structure where
   technical.md summarizes it.
4. [architecture.md](docs/architecture.md): summary; the detailed contracts win.
5. [improvements.md](docs/improvements.md): optional backlog (I-xx), never acceptance
   scope. Bonus tracks I-01–I-04 (P2) start after M1; other items only after P0.
6. [monorepo-migration.md](docs/monorepo-migration.md): record of the move to this
   monorepo and its open points.

This file sets implementation conventions, not exceptions to product requirements.
Open questions are not settled requirements: resolve routine choices yourself, ask
when a choice materially changes scope, data access or product behavior. When a
decision changes, name the conflict and keep the affected documents aligned. Do not
create a parallel knowledge base or require tools, credentials or conventions from
unrelated repositories.

Tickets live only in **Linear** (workspace `loginsights2`, team `LOG`, IDs `LOG-xx`),
read and updated through the Linear MCP. **Never use Plane** for this repository.
Linear projects are the work areas; their milestones are stages prefixed with their
gate (`M1 ·`, `Ausbau ·`, `M2 ·`). Each work package is one ticket; a package spanning
two milestones has one sub-issue per milestone.

Read these before working in their area (Claude loads the rules automatically for
matching paths):

- Ticket, branch, commit and PR steps: `.claude/skills/ticket-workflow/SKILL.md`
- Anything under `apps/web` or `packages/ui`: `.claude/rules/web-ui.md`
- Anything under `packages/evals`: `.claude/rules/evals.md`

## Product and domain invariants

- SereneDB computes counts, trends, comparisons, episodes, precursors, percentiles
  and rankings. The model explains; it never invents or computes numbers, events or
  sources. Every number in an answer comes from a tool result and cites the fact ID
  the tool assigned (for example `r_7f3a9c21.f4`), never a constructed path.
- Frequencies come from aggregation tools over the stated scope, never from search
  hits or samples. Truncated results say so.
- Log events, OpenStack API access events (with or without request ID) and unique
  request IDs are separate counting units (R-01). Rates name numerator and
  denominator; 4xx means 400–499, 5xx means 500–599.
- Roles are playbooks: they change the question, the evidence selected, the check
  run before recommending, the answer structure and the kind of next step, not just
  the length. Answers share a frame (Scope, Answer, Unknown, Verification) with a
  role-specific core. Playbooks also apply when the client selected no role prompt
  (server instructions, `describe_corpus`). The same normalized tool input on the
  same data version yields identical numbers across roles and clients; the same
  question text does not guarantee that.
- Keep observations, hypotheses and proven causes apart. Missing or mixed evidence
  leaves a hypothesis open; supported is not causally proven. A hypothesis status
  names its discriminating check. Precursors are temporal observations, never
  causes (R-11).
- Manager priorities rank by episodes and breadth, not log-line volume, and name
  trade-offs between dimensions; there is no composite risk score (R-08, R-09).
- UTC is the visible default. Time windows include the start and exclude the end.
  BGL time comes from its Unix seconds. Buckets outside a dataset's span are not zero.
- BGL (2005–2006) and OpenStack (2017) share no time axis: trends and comparisons
  are per dataset; cross-dataset numbers are labelled totals over each full span.
- Matched entries, patterns and episodes are not incidents or outages. Follow
  R-01–R-11 rather than inventing other grouping, status or ranking rules.
- The ownership table is fictional and labelled so; unmapped components are
  `unowned`. Dataset labels (BGL alerts, OpenStack anomalies) are not our findings.
- No invented business impact, downtime, cost or customer effect; say what is
  unknown. Never present unsupported capabilities or synthetic results as real data.
- No production changes, autonomous fixes, tickets or paging.
- UI, code identifiers, README and submission material are English; planning docs
  are German. Never translate or rewrite original log evidence.

## Architecture and dependencies

pnpm workspace monorepo with Turborepo, one root lockfile, toolchain pinned (Node 24,
pnpm 11.25). Several stack parts are decided but not installed yet: inspect installed
versions before using an API, and never infer an installation from a plan.

- Decided stack: TypeScript strict, `tsx` for scripts and the MCP process; SereneDB
  via Docker Compose and `pg` (no ORM, no query builder); Zod as the single contract
  for tool inputs/outputs, MCP schemas and AI SDK tools; `@modelcontextprotocol/sdk`
  (stdio; Streamable HTTP is P1); Vercel AI SDK with `@ai-sdk/anthropic` and
  `@ai-sdk/react` (one streaming request with tools and a step limit; Claude is the
  model, `claude-opus-5-5` by default and for eval, baseline and demo runs, because
  the judges use it); Next.js App Router, Tailwind, shadcn/ui on Base UI, Lucide;
  TanStack Query only where interactive client fetching needs it.
- Not used (concept v3.0): Effect, SQLite, a worker or job queue, Caddy or another
  proxy, a second agent framework, Python services, a vector database. Add none of
  these, nor another service, ORM or schema library, without a need recorded in
  technical.md.
- Internal packages (`@workspace/*`, the web app is `web`) export TypeScript sources
  without a build step; Next transpiles them via `transpilePackages`. Depend on
  workspaces with `workspace:*`. The root `package.json` holds tooling only. Extend
  `@workspace/typescript-config` and `@workspace/eslint-config` instead of copying
  options.
- Planned workspaces, each created with its first real code: `apps/web`, `apps/mcp`
  (server, resources, prompts, desktop config), `packages/agent` (role playbooks as
  export `./playbooks`, AI SDK adapter as `./ai-sdk`), `packages/evals`. Preserve the
  boundaries in technical.md § 4; do not scaffold empty layers.
- Allowed workspace dependencies: `domain` on none; `analytics` only on `domain`;
  `agent` on `analytics` and `domain`; `apps/mcp` on `analytics`, `domain` and only
  the `./playbooks` export of `agent`; `apps/web` on all. No package except
  `apps/web` depends on `next`, `react` or `server-only`: the MCP process and the
  eval runner load them without Next, and `server-only` throws there.
  `pnpm deps:check` enforces the rest (cycles, cross-workspace relative imports,
  generic `packages/ui`, no server workspaces in the browser graph, private
  `partials/`).
- `packages/analytics` is the only place that executes SQL. Routes, components, the
  MCP server and the web chat all go through the same tool registry. Pure domain
  code stays independent of Next.js, React, database drivers and provider SDKs.

## SereneDB, tools and receipts

- SereneDB speaks the PostgreSQL wire protocol but is a different engine. Check its
  behavior with the `serenedb-docs` MCP (or `sdb_docs.search`) before writing or
  changing SQL. Gate results and required rewrites are in technical.md § 5.2; rerun
  `pnpm gate` after any image change (a `DIFF` means documented behavior changed).
- The image is SereneDB 26.10.1 from `SERENEDB_IMAGE` (technical.md § 5.1): the
  unofficial, unpublished `local/serenedb:26.10.1-arm64` on Apple Silicon (restored
  with `docker image load`, never pulled or rebuilt for a run), the official
  digest-pinned amd64 image in CI. Never point an image at another version's data
  volume; experiments use their own `COMPOSE_PROJECT_NAME`, volume and
  `SERENEDB_PORT`, and leave other checkouts' instances alone.
- Type every bound parameter that appears in a result expression (`$1::BIGINT + 1`,
  `ts_levenshtein($1::VARCHAR, $2::INTEGER)`) and never wrap a parameter in a JSON
  function in the select list: SereneDB 26.10.1 otherwise describes the result as
  one `unknown` column (gate G1), which the pool rejects.
- Each process owns one lazily created `pg` pool (at most four connections, never at
  import or build time), disposed at shutdown and in test teardown; account for dev
  reloads. Every query has a 10 s limit enforced by the pool: SereneDB accepts
  `statement_timeout` but does not enforce it (gate G6), and `pg`'s `query_timeout`
  alone leaves the query running and the connection unusable. The pool cancels
  server-side (`pg_cancel_backend` or protocol cancel, SQLSTATE `57014` →
  `query_timeout`) and discards the connection.
- Each connection runs `SET TimeZone = 'UTC'` after connecting (the startup option is
  ignored). Timestamps cross the driver as text, never `Date` (process time zone,
  lost microseconds). `BIGINT` stays exact (string or `bigint`) until a range check
  allows a JavaScript number.
- Every tool is a registry entry with name, title, version, description, Zod input
  and output, and `run()`. Descriptions state purpose, when to use and when not,
  inputs with units and limits, outputs and truncation behavior. Tool schemas live in
  `domain/tools/`; JSON Schema snapshots change only with a `CONTRACT_VERSION` bump
  (patch for description-only changes), updated with `pnpm vitest run -u`.
- Eight tools, all P0 (technical.md § 8.2). Prefer a parameter on an existing tool
  over a new tool (`compare` of `count_events`, `rank: investigation_order` of
  `recurring_patterns`, the `aggregate` mode of `get_log_context`). The optional
  index tools (A-33) are registered only with `LOG_INSIGHTS_WORKSPACE_TOOLS=1`.
- Every run writes one receipt JSON in `.data/receipts/` (validated input with
  resolved defaults, exact SQL, bound params, scope, data version, population, rows,
  truncated, duration, result, result digest, facts) and returns its summary plus
  the fact list. A run whose receipt cannot be stored fails with
  `receipt_unavailable`. The eight default tools never write to SereneDB; only the
  index tools create and drop their own indexes. Tools return the derived values
  answers need (shares, deltas, rates, totals, ratios) so the model never computes.
- SereneDB computes, TypeScript does not (technical.md § 5.3): every analytical value
  and every rule outcome (R-05 flag, R-06 classification, R-08 order, R-09
  dominance, R-10 status, zero buckets inside the data span) comes from SQL.
  TypeScript validates input, assembles allowlisted SQL, assigns fact IDs, writes
  receipts and checks claims; the pure functions in `domain/rules/` serve as test
  oracles, not as the computation. Before writing generic SQL or computing outside
  SereneDB, search the SereneDB docs (`sdb_docs.search`, the docs MCP or Context7
  `/serenedb/serenedb`) for a SereneDB-native function, and record each one used or
  rejected in technical.md § 5.3 with its gate probe or reason. SereneDB AI
  functions in SQL (`ai_*`) and vector search on them are not used (concept 3.2).
- Every row-returning query ends its `ORDER BY` in a unique key, so result digests
  are reproducible. Episodes are computed after the full scope is filtered, never
  from precomputed global gaps.
- Parameterize all SQL values; allowlist columns, dimensions, sorts and operations.
  The agent never sends SQL. Re-run executes the registered tool with the stored
  validated input, never stored SQL.
- Expected failures are one discriminated union (`invalid_input`, `not_found`,
  `query_timeout`, `db_unavailable`, `receipt_unavailable`, `limit_exceeded`),
  mapped once to MCP errors and route responses with a correction hint. Never expose
  raw database errors or stacks.
- `check_claims` verifies each claim against its fact ID (value, metric and required
  group; scope comes from the receipt) and counts unknown fact IDs or receipts as
  unresolved. MCP and web chat share the number format and the check; there is no
  web-only verifier. Answers state how many claims were checked; nothing verifies
  explanations, and model prose is never the authoritative numerical source.
- Role playbooks live once in `agent/playbooks/` and feed the MCP prompts, the
  server instructions, `describe_corpus` and the web system prompt. No second copy.
- MCP over stdio: stdout belongs to the protocol. Log to stderr only; start the
  server with `pnpm --silent mcp`.
- Model calls: no retries beyond a disabled or bounded SDK default; never retry
  invalid input or timeouts without narrowing the request.

## Data, safety and secrets

- Raw corpus files live in `.data/` (gitignored, never committed). Loading is
  idempotent (`CREATE OR REPLACE TABLE`, after dropping the views that depend on
  the replaced tables, gate G3); load checks compare line counts with the
  brief and record rejects with reasons. `pnpm data:setup --samples` loads the
  Loghub 2k samples into the separate database `log_insights_samples`.
- Validate input sizes, limits and time ranges; bound result sets. Never read a whole
  dataset into React or the model to calculate a total.
- Logs and model output are untrusted text: render safely, no raw HTML, no unsafe
  link protocols. Log text never changes rules or tool access.
- SereneDB and the web app bind to loopback only; there is no user system.
- Validate configuration at startup. Secrets stay out of source control, client
  bundles, fixtures, URLs, logs and error responses; commit only `.env.example`.
  Operational logs carry tool name, duration, result size and error kind, never
  prompts, credentials, model payloads or raw log text.

## Code conventions

- Avoid unsafe assertions, non-null assertions and compiler or lint suppressions. A
  necessary interop escape hatch is localized, explained and validated; type tests
  may use a documented `@ts-expect-error`.
- Infer DTO types from the canonical Zod schemas instead of parallel interfaces.
- Preserve missing/null semantics: never coerce absent facts to zero or empty text.
  Keep date formatting separate from UTC storage and comparison.
- Record meaningful deferred limits with a reason and a revisit condition.
- Fix lint findings instead of suppressing them; config rule changes need a stated
  reason. Existing exceptions: `jsx-a11y/control-has-associated-label` is off because
  Base UI `render={<a />}` props are false positives (axe checks the rendered DOM);
  generated files in `packages/ui/src/components` are exempt from `no-shadow` and
  `prefer-tag-over-role`; `pnpm-workspace.yaml` allows ESLint 10 for
  `eslint-plugin-react`, `-import` and `-jsx-a11y`, whose peer ranges stop at 9
  although their rules were verified to run; knip exempts the exports of
  `packages/ui/src/components` (shadcn generates complete APIs) and ignores `tsx` in
  `packages/analytics` (tests start it only as `node --import tsx`).

## Tests and checks

- Vitest for domain, tool and MCP tests, Playwright for critical browser flows. Unit
  tests sit beside the code; golden and integration suites in
  `packages/analytics/tests/`, E2E in `apps/web/tests/e2e/`. Expected values never
  come from the tool code under test.
- Keep real SereneDB tests; mocks cannot verify query behavior. CI runs the tools
  against the Loghub 2k samples; golden queries run locally against the full corpus.
- Cover time boundaries, process time zones, missing values, comparison
  denominators, episode rules under filters, precursor anchors and baselines,
  rankings and dominance, truncation, empty results, receipts and fact IDs,
  `check_claims` mismatches and unresolved claims, prompt injection in log text, and
  database timeouts.
- Golden queries for a tool are written by a different agent than its implementer.
  Preserve S-01–S-16 and the role eval with its pass threshold (technical.md § 13).
- `pnpm check` runs lint, typecheck, format, dependency, knip and unit checks. CI
  adds the build and a `loader` job (`pnpm data:setup --samples`, then
  `pnpm test:integration`, which needs Docker and `.env`). `pnpm gate`,
  `pnpm data:profile` and the full-corpus `pnpm data:setup` run only locally. Keep
  CI green.
- Never name a script `setup`: `pnpm setup` is a built-in that edits the shell
  configuration. Env vars that code reads must be declared in `turbo.json`. Planned
  scripts (technical.md): `pnpm mcp`, `pnpm mcp:desktop-config`, `pnpm test:golden`,
  `pnpm eval`, `pnpm report:perf`, `pnpm test:e2e`; add each in its workspace with a
  root alias.
- A successful build does not verify accessibility, runtime behavior or data
  correctness. Review the final diff for accidental files, sensitive content, stale
  docs and scope drift.

## Git

This file is the owner's standing authorization: for work on a ticket (or `NT:` work
the user asked for), agents push the branch, open the pull request and merge it
themselves once every required check is green, without asking first. The steps are
in `.claude/skills/ticket-workflow/SKILL.md`. Nothing reaches `main` except through a
merged pull request: never push to `main`, never force-push a shared branch, never
bypass branch protection, and never skip, disable or weaken a check to get green. Stop and ask instead of merging when the change needs a decision
the ticket does not cover or review comments are open.

<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->
