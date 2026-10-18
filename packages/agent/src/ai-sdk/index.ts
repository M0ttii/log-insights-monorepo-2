/**
 * The `@workspace/agent/ai-sdk` entry (technical.md § 4, § 11, § 11.1). It
 * builds the AI SDK pieces on top of the registry and playbooks: the phase
 * machine `runInvestigation`, its input schema and types, the registry → AI SDK
 * tool adapter, the model and provider options, the run record store, the
 * coverage helpers, the baseline instruction texts, and the CLI.
 *
 * This entry never imports `next`, `react`, `server-only` or the MCP SDK
 * (AGENTS.md, technical.md § 4, enforced by dependency-cruiser).
 */

export {
  convertToModelMessages,
  DEFAULT_LIMITS,
  investigationInputSchema,
  investigationRoleSchema,
  investigationScopeSchema,
  investigationVariantSchema,
  runInvestigation,
  type InvestigationDeps,
  type InvestigationInput,
  type InvestigationLimits,
  type InvestigationPlaybooks,
  type InvestigationResult,
  type InvestigationRole,
  type InvestigationScope,
  type InvestigationUIMessage,
  type InvestigationVariant,
  type PhasePrompt,
} from "./investigation.ts"

export {
  BASELINE_INSTRUCTIONS,
  baselineRegistryGuidance,
  baselineRoleInstruction,
  type BaselineRole,
} from "./baseline.ts"

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
