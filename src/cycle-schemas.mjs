/**
 * Zod schemas for cycle-state/ output files.
 *
 * Each cycle writes a JSON file to .harness/cycle-state/.
 * The outer loop reads these files to make queue decisions.
 * Validate before trusting any field — malformed output causes wrong branching.
 */

import { z } from 'zod';

// ── Per-cycle output schemas ───────────────────────────────────────────────────

export const ExploreReport = z.object({
  // Accept any reasonable explorer report shape — field names and nesting vary by model output.
  // Required: task description and at least one of summary/findings/relevant_files.
  task: z.string().optional(),
  summary: z.string().optional(),
}).passthrough();

export const PlanReport = z.object({
  workPackages: z.array(
    z.object({
      agent: z.string(),
      files: z.array(z.string()),
      canRunParallel: z.boolean().optional(),
    }),
  ),
  sharedContracts: z.array(z.string()),
  sequencing: z.string().optional(),
  risks: z.array(z.string()).optional(),
  outOfScope: z.array(z.string()).optional(),
});

export const ImplementReport = z.object({
  // filesChanged: accept both plain strings and {file|path, summary} objects
  filesChanged: z.array(z.union([z.string(), z.object({}).passthrough()])),
  outOfScopeGaps: z.array(z.union([z.string(), z.object({}).passthrough()])),
  notes: z.string().optional(),
});

export const AdditionalGroupEntry = z.object({
  reason: z.string(),
  subTask: z.string(),
  suggestedPromptType: z.enum(['implement-feature', 'fix-bug', 'edit-feature', 'create-app']),
  suggestedAgents: z.array(z.string()).optional(),
  group: z.string(),
});

export const ReconcileReport = z.object({
  contractsAligned: z.boolean(),
  redelegationLog: z.array(
    z.object({
      gap: z.string(),
      agent: z.string(),
      spawned: z.boolean(),
      result: z.string(),
    }),
  ),
  consistencyPassed: z.boolean(),
  residualRisks: z.array(z.union([z.string(), z.object({}).passthrough()])),
  requiresAdditionalGroups: z.array(AdditionalGroupEntry).optional(),
});

const TargetEntry = z.union([
  z.string(),
  z.object({ project: z.string().optional(), target: z.string().optional(), result: z.string().optional() }).passthrough(),
]);
const TestWrittenEntry = z.union([z.string(), z.object({}).passthrough()]);
const FailureEntry = z.union([z.string(), z.object({}).passthrough()]);

export const TestReport = z.object({
  passed: z.boolean(),
  targetsRun: z.array(TargetEntry),
  failures: z.array(FailureEntry).optional(),
  failedSurfaces: z.array(z.string()).optional(),
  coverageGaps: z.array(z.string()).optional(),
  testsWritten: z.array(TestWrittenEntry).optional(),
});

export const SmokeReport = z.object({
  passed: z.boolean(),
  skipped: z.boolean().optional(),
  reason: z.string().optional(),
  authIssue: z.enum(["missing", "stale"]).optional(),
  affectedPages: z.array(z.string()).optional(),
  pagesChecked: z.array(z.object({ url: z.string(), httpStatus: z.number().optional() }).passthrough()).optional(),
  apiCallsChecked: z.array(z.object({ url: z.string(), status: z.union([z.number(), z.string()]).optional() }).passthrough()).optional(),
  failures: z.array(z.union([z.string(), z.object({}).passthrough()])).optional(),
}).passthrough();

export const FixReport = z.object({
  fixed: z.array(z.string()),
  notes: z.string().optional(),
});

export const SkillsReport = z.object({
  invoked: z.array(z.string()),
  output: z.record(z.string(), z.string()),
});

// ── Human answers (cycle-state/human-answers.json) ────────────────────────────

export const QuestionEntry = z.object({
  key: z.string().optional(),
  question: z.string(),
  options: z.union([z.array(z.string()), z.string()]).optional(),
  recommendation: z.string().optional(),
});

export const AnswerDecision = z.object({
  cycleId: z.string(),
  questions: z.array(QuestionEntry),
  answer: z.string().min(1),
});

export const HumanAnswerRecord = z.object({
  answeredAt: z.string(),
  resolvedCycles: z.array(z.string()),
  decisions: z.array(AnswerDecision),
});

export const HumanAnswersFile = z.array(HumanAnswerRecord);

export const ReproduceReport = z.object({
  reproduced: z.boolean(),
  failureDescription: z.string(),
  rootCause: z.string().optional(),
  affectedFiles: z.array(z.string()).optional(),
  notes: z.string().optional(),
});

// ── Task queue schema ─────────────────────────────────────────────────────────

export const CycleEntry = z.object({
  id: z.string(),
  type: z.enum([
    'orchestrate',
    'explore',
    'plan',
    'reproduce',
    'implement-backend',
    'implement-frontend',
    'implement-distributed',
    'implement-infra',
    'reconcile',
    'test',
    'fix',
    'smoke',
    'recovery',
    'deliver',
  ]),
  status: z.enum(['pending', 'done', 'blocked', 'partial']).default('pending'),
  agent: z.string().nullable().optional(),
  outputFile: z.string().optional(),
  target: z.string().optional(),
  parallel: z.boolean().optional(),
  notes: z.string().optional(),
  blockedReason: z.string().optional(),
  partialReason: z.string().optional(),
  completedAt: z.string().optional(),
  turns: z.number().optional(),
  taskGroup: z.string().nullable().optional(),
  subTask: z.string().optional(),
});

export const IntentEntry = z.object({
  subTask: z.string(),
  promptType: z.enum(['implement-feature', 'fix-bug', 'edit-feature', 'create-app']),
  group: z.string(),
});

export const TaskQueue = z.object({
  task: z.string(),
  promptType: z.enum(['implement-feature', 'fix-bug', 'edit-feature', 'create-app', 'multi-intent']),
  intents: z.array(IntentEntry).optional(),
  cycles: z.array(CycleEntry),
});

// ── Schema registry — maps outputFile name patterns to schemas ────────────────

const SCHEMA_REGISTRY = [
  { pattern: /^skills\.json$/,              schema: SkillsReport,    name: 'SkillsReport'    },
  { pattern: /^explore(-[^.]+)?\.json$/,    schema: ExploreReport,   name: 'ExploreReport'   },
  { pattern: /^plan(-[^.]+)?\.json$/,       schema: PlanReport,      name: 'PlanReport'      },
  { pattern: /^reproduce(-[^.]+)?\.json$/,  schema: ReproduceReport, name: 'ReproduceReport' },
  { pattern: /^implement-.+\.json$/,        schema: ImplementReport, name: 'ImplementReport' },
  { pattern: /^reconcile(-[^.]+)?\.json$/,  schema: ReconcileReport, name: 'ReconcileReport' },
  { pattern: /^test(-[^.]+)?\.json$/,       schema: TestReport,      name: 'TestReport'      },
  { pattern: /^fix-.+\.json$/,              schema: FixReport,       name: 'FixReport'       },
  { pattern: /^smoke(-[^.]+)?\.json$/,      schema: SmokeReport,     name: 'SmokeReport'     },
];

/**
 * Validate a parsed JSON object against the schema for the given filename.
 * Returns { valid: true, data } or { valid: false, errors, schemaName }.
 * Returns { valid: true, data: raw, skipped: true } if no schema matches the filename.
 */
export function validateCycleOutput(filename, raw) {
  const entry = SCHEMA_REGISTRY.find((r) => r.pattern.test(filename));
  if (!entry) return { valid: true, data: raw, skipped: true };

  const result = entry.schema.safeParse(raw);
  if (result.success) {
    return { valid: true, data: result.data };
  }
  return {
    valid: false,
    schemaName: entry.name,
    errors: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
  };
}

/**
 * Validate task-queue.json.
 * Returns { valid: true, data } or { valid: false, errors }.
 */
export function validateTaskQueue(raw) {
  const result = TaskQueue.safeParse(raw);
  if (result.success) return { valid: true, data: result.data };
  return {
    valid: false,
    errors: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
  };
}

/**
 * Files where invalid JSON or a missing critical field must be treated as a
 * hard failure — the outer loop cannot safely continue without them.
 *
 * Degradation policy:
 *   critical  → invalid JSON = treat as cycle failure (inject fix / retry)
 *               missing field = use conservative default (e.g. passed: false)
 *   non-critical → invalid JSON or mismatch = warn + continue with partial data
 */
export const CRITICAL_OUTPUT_FILES = new Set(['test.json', 'smoke.json']);

/**
 * Conservative defaults for critical fields when schema validation finds them
 * missing or wrong-typed. Used by the outer loop, not by validateCycleOutput.
 */
export const CONSERVATIVE_DEFAULTS = {
  'test.json':  { passed: false, targetsRun: [], failedSurfaces: [], failures: [] },
  'smoke.json': { passed: false, failures: [] },
};
