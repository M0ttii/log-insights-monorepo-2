// Architecture rules from AGENTS.md ("Target layout", "Functional areas and
// local partials", "Next.js and React boundaries") and technical.md § 4.
// Layer rules between domain, analytics, agent and mcp are package boundaries
// now: a workspace can only import what its package.json declares. The rules
// below cover what package boundaries cannot express. Folders that do not exist
// yet are listed so the rules apply as soon as they are created.

// Node-only workspaces: the MCP process, setup scripts and evals load them
// without Next, and they must never reach the browser graph.
const SERVER_WORKSPACES = "^(packages/(analytics|agent|corpus|evals)|apps/mcp)/"
const FUNCTIONAL_AREAS =
  "^apps/web/components/(workspace|investigation|logs|datasets|evidence|roles|charts|quality|providers)/"

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      comment:
        "Module and workspace dependencies must stay acyclic, across packages too.",
      from: {},
      to: { circular: true },
    },
    {
      name: "no-radix-or-chat-runtime",
      severity: "error",
      comment:
        "Base UI shadcn only; no Radix and no assistant-ui (AGENTS.md, ui-concept.md § 10).",
      from: {},
      to: { path: "node_modules/(radix-ui|@radix-ui|@assistant-ui)/" },
    },
    {
      name: "ui-package-stays-generic",
      severity: "error",
      comment:
        "packages/ui holds generic shadcn primitives; it must not import apps or functional areas.",
      from: { path: "^packages/ui/" },
      to: { path: ["^apps/", FUNCTIONAL_AREAS] },
    },
    {
      name: "no-server-code-in-browser-graph",
      severity: "error",
      comment:
        "Web components, hooks and lib must not import analytics, agent, corpus, evals or the MCP app.",
      from: { path: "^apps/web/(components|hooks|lib)/" },
      to: { path: SERVER_WORKSPACES },
    },
    {
      name: "no-relative-cross-workspace-imports",
      severity: "error",
      comment:
        "Import other workspaces by package name (@workspace/…), never by relative path.",
      from: { path: "^(apps|packages)/([^/]+)/" },
      to: {
        path: "^(apps|packages)/",
        pathNot: "^$1/$2/",
        dependencyTypes: ["local"],
        // tsconfig path aliases (@workspace/ui/*) resolve to source files too;
        // they are package imports, not relative paths.
        dependencyTypesNot: ["aliased"],
      },
    },
    {
      name: "private-partials",
      severity: "error",
      comment:
        "A partials/ folder may only be imported from within its own area.",
      from: { path: "^apps/web/components/([^/]+)/" },
      to: {
        path: "^apps/web/components/([^/]+)/partials/",
        pathNot: "^apps/web/components/$1/partials/",
      },
    },
    {
      name: "not-to-unresolvable",
      severity: "error",
      comment: "Every import must resolve.",
      from: {},
      to: { couldNotResolve: true },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: {
      path: "(^|/)(\\.next|\\.turbo|coverage|playwright-report|test-results)/|next-env\\.d\\.ts$",
    },
    tsPreCompilationDeps: true,
    // The root tsconfig maps the aliases of apps/web (@/*) and packages/ui
    // (@workspace/ui/*) for repository-wide tools; workspaces typecheck with
    // their own tsconfig.
    tsConfig: { fileName: "tsconfig.json" },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
      extensions: [".ts", ".tsx", ".js", ".mjs", ".cjs", ".json"],
    },
    skipAnalysisNotInRules: true,
  },
}
