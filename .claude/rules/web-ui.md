---
paths:
  - "apps/web/**"
  - "packages/ui/**"
---

# Web app and UI conventions

Read with ui-concept.md, which is authoritative for UI structure. Once `apps/web`
exists, `next dev` manages Next.js-specific agent rules in `apps/web/AGENTS.md`;
preserve that generated block.

## Layout and functional areas

Organize UI by functional responsibility. Inside `apps/web` the `@/*` alias maps to
`apps/web/*`; packages import each other by package name and themselves relatively.
Create directories as needed; do not move unrelated files for symmetry.

```text
apps/web/
  app/                # routes, layouts, route handlers (chat, receipts, search)
  components/
    providers/        # React context providers
    workspace/        # shell, navigation, overview
    investigation/    # Ask: chat, role switcher, answer sections
    logs/             # LogsView and its local implementation
    datasets/         # corpus, schema and ownership views
    evidence/         # shared EvidenceDrawer: receipts, events, SereneDB features
    results/          # one result view per tool output schema, shared by chat,
                      # drawer, overview and logs
    charts/           # shared timelines and equivalent tables
  tests/e2e/          # Playwright suites
packages/ui/          # shadcn primitives (src/components), hooks (src/hooks),
                      # cn() (src/lib), globals.css and tokens
```

- Route `page.tsx` files stay thin: route configuration, server-side orchestration
  where needed, rendering views from the functional areas. `layout.tsx` composes
  the shells and navigation from `workspace/`.
- Each area owns its views, local hooks, presentation types, mappers and unit tests.
  Shared contracts and rule functions stay in `domain/`, never duplicated in UI.
- Descriptive PascalCase component names (`InvestigationView`, `LogsView`,
  `EvidenceDrawer`); short local helper names (`types.ts`, `mapper.ts`,
  `useInvestigation.ts`).
- `partials/` holds private sections of a larger view; small areas may stay flat.
  Other areas never import private partials or helpers.
- Reuse through explicit public component files or a small optional `index.ts`; no
  blanket barrels, and no server-only internals in an entry point the browser
  imports.
- Shared use does not move ownership: `EvidenceDrawer` stays in `evidence/`,
  `EventTimeline` in `charts/`. No parallel `pages/`, `molecules/` or `templates/`
  taxonomies.
- React context setup lives in `providers/`, as deep in the tree as practical.
- Views compose shared areas and `ui/` primitives. Primitives never import
  functional areas; shared areas never depend on their consuming views.

## Server/client boundary

- Keep secrets and data clients server-side, with `server-only` in Next-specific
  server adapters (never in `analytics`).
- Pass narrow serializable DTOs to the client, not pools, driver-typed rows or
  errors. Server Components read the registry directly instead of calling the app's
  own HTTP endpoints.
- Route handlers validate every input with the tool's Zod schema. GET never mutates
  state; the receipt written inside a tool run is the only write.
- `ANTHROPIC_API_KEY` stays server-side. Without it the chat is disabled with a
  clear message and the rest of the app works.
- Follow the installed Next.js version for request data, params, caching and
  invalidation: read `node_modules/next/dist/docs/` when available.
- Chat state lives in `useChat`; no competing loading or status flags. Stable entity
  IDs (`event_id`, `receipt_id`) are React keys.

## shadcn/ui

- Use the Impeccable skill for UI design work (new interfaces, redesigns, visual or
  interaction refinements), together with the shadcn rules below.
- Primitives are shadcn on Base UI (`@base-ui/react`, style `base-nova`) with the
  configured tokens. No Radix-based variants, no mixed primitive systems.
- Before building or changing UI, search the shadcn MCP registries for a matching
  component, block or AI Elements pattern, view its examples and install it with the
  add command the MCP returns. Only if the MCP is unavailable or lacks the item, use
  the official command for the Base UI variant matching `components.json`
  (`pnpm dlx shadcn@latest add <name> -c apps/web` from the root) and note the
  fallback in the ticket. Add only what is needed; review generated code and
  dependencies (no Radix), including accessibility.
- Wherever shadcn offers a component, block or AI Elements pattern, use it instead of
  recreating it from `div`/`button`/`input` and Tailwind. Raw elements are limited to
  document semantics (headings, paragraphs, lists, landmarks, `time`, ordinary
  links) and the inside of shadcn components. If nothing fits, compose existing
  shadcn components; a truly custom element needs a stated reason in the ticket or
  PR. Prefer blocks for page structure (for example the Sidebar block) and adapt
  them rather than rewriting their markup.
- The CLI writes primitives to `packages/ui` (import as
  `@workspace/ui/components/<name>`) and block wrappers to the app; wrappers such as
  `app-sidebar.tsx` or `nav-*.tsx` belong to the owning area, e.g.
  `components/workspace/`.
- Chat: the Base UI variant of shadcn AI Elements with its AI SDK integration
  (`useChat`, streamed message parts), per ui-concept.md § 10. Render model text
  with a safe Markdown renderer without raw HTML. No Reasoning pattern, no
  assistant-ui or other chat runtime, no separate `components/ai-elements/` folder.

## Tokens, accessibility and states

- Theme: the SereneDB design kit (`vendor/serene-design`, CSS only) under the
  token layer in `packages/ui/src/styles/globals.css`; dark is the default via
  `.dark` on `<html>`, light is a full theme. Never import the kit's `theme.css`
  or components (Radix), and never give a kit token another meaning; map it in
  `@theme inline` instead (DESIGN.md, Source).
- Violet text uses `text-link`, never `text-primary` (a fill colour, below 4.5:1
  as text on the dark ground); primary hover is `bg-primary-hover`, not an
  alpha fade.
- Shared tokens instead of scattered colors and arbitrary spacing. Level, tool
  state, hypothesis status, pattern status (R-10) and verification are separate
  status token sets; hypothesis status never uses success or error colors.
- Labels, visible focus, keyboard operation, accessible names, sensible focus return
  and associated errors. Status needs text, not color alone. Charts include
  equivalent tables. Respect reduced motion.
- Preserve input on failures, distinguish running, failed, truncated and empty
  states, prevent duplicate submissions, and avoid unexpected scrolling during
  streaming. The web app has no verifier of its own: it only marks fact IDs that
  were not submitted to `check_claims` (`unchecked`) and numbers or times without
  a following fact ID (`uncited`, ui-concept.md § 4.3). Several `check_claims`
  calls are shown one by one, never summed.
- Views format values and never compute them: no sums, differences, shares,
  ranks or re-sorting of tool results; `null` stays "Unknown" or "not
  determinable", never 0.
- Verify 1280×800 and 1920×1080; narrower widths keep every action reachable. Long
  messages and SQL scroll inside their panel, never the page.
- Exercise changed UI flows and inspect browser and server errors.
- `pnpm test:e2e` (planned, Playwright + axe): both viewports, no serious or
  critical axe violations, no console errors, no horizontal overflow. Known issues
  use `test.fixme` with a ticket reference, never a silent skip.
