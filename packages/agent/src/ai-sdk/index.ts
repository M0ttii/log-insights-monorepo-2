/**
 * The `@workspace/agent/ai-sdk` entry (technical.md § 4, § 11.1). It builds the
 * AI SDK pieces on top of the registry and playbooks: the model and provider
 * options, the registry → AI SDK tool adapter, the run record store and the
 * coverage evaluation. The phase machine `runInvestigation` and its CLI wiring
 * land in a later stage; this half exports the building blocks they consume.
 *
 * This entry never imports `next`, `react`, `server-only` or the MCP SDK
 * (AGENTS.md, technical.md § 4, enforced by dependency-cruiser).
 */

export {
  CHAT_DISABLED_MESSAGE,
  ChatDisabledError,
  DEFAULT_EFFORT,
  DEFAULT_MODEL_ID,
  EFFORT_LEVELS,
  resolveModel,
  type Effort,
  type ModelConfig,
  type ModelOptions,
} from "./model.ts"

export {
  buildTools,
  modelView,
  type ModelToolError,
  type ModelToolView,
  type ToolExecuteResult,
} from "./tools.ts"

export {
  checkClaimsSummarySchema,
  FileRunStore,
  gateFindingsSchema,
  newRunId,
  phaseKindSchema,
  resolveRunsDir,
  runPhaseSchema,
  runRecordSchema,
  runRolesSchema,
  runRoleSchema,
  runStatusSchema,
  runStepSchema,
  runUsageSchema,
  runVariantSchema,
  RUN_ID_PATTERN,
  runIdSchema,
  type PhaseKind,
  type RunPhase,
  type RunRecord,
  type RunStatus,
  type RunStep,
  type RunStore,
  type RunUsage,
} from "./run-record.ts"

export {
  claimsHint,
  coverageHint,
  missingCoverage,
  type CoverageAlternative,
  type CoverageStep,
  type RoleCoverage,
} from "./coverage.ts"

export { CliUsageError, parseCliArgs, runCli, type CliArgs } from "./cli.ts"
