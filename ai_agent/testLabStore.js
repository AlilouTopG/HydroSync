'use strict';

const crypto = require('crypto');

const TRANSITIONS = Object.freeze({
  DRAFT: ['AWAITING_APPROVAL', 'CANCELLED', 'FAILED'],
  AWAITING_APPROVAL: ['APPROVED', 'CANCELLED', 'EXPIRED', 'FAILED'],
  APPROVED: ['RUNNING', 'CANCELLED', 'EXPIRED', 'FAILED'],
  RUNNING: ['EVALUATING', 'ABORTED', 'FAILED'],
  EVALUATING: ['COMPLETED', 'FAILED'],
  COMPLETED: [], CANCELLED: [], EXPIRED: [], ABORTED: [], FAILED: []
});

const SCENARIOS = Object.freeze({
  normal_operation: Object.freeze({
    id: 'normal_operation', label: 'Normal operation', supported: true,
    parameters: Object.freeze({ durationSeconds: { min: 5, max: 30, default: 10 } }),
    preconditions: ['Normal simulator mode is active.', 'No SCADA safety trip or simulator interlock is active.', 'Pump telemetry is available.'],
    expectedObservations: ['Simulator remains in normal mode.', 'No safety trip or simulator interlock is active during the observation window.'],
    acceptanceCriteria: ['At least one telemetry observation is recorded.', 'No safety trip or simulator interlock occurs during the observation window.'],
    abortConditions: ['A safety trip or simulator interlock occurs.', 'Telemetry becomes unavailable.'],
    maxDurationMs: 30_000, requiredEvidence: ['start and end timestamps', 'current simulator telemetry', 'safety state']
  }),
  fault_injection: Object.freeze({
    id: 'fault_injection', label: 'Fault injection', supported: false,
    reason: 'The existing fault demo bypasses safety interlocks and resets trip state. Test Lab fault injection is disabled until a dedicated interlock-preserving simulator mode exists.'
  })
});

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}

function hashPlan(plan) { return crypto.createHash('sha256').update(canonical(plan)).digest('hex'); }

function createTestLabStore({ now = Date.now, ttlMs = 10 * 60_000, approvalTtlMs = 2 * 60_000 } = {}) {
  const runs = new Map();

  function transition(run, next) {
    if (!TRANSITIONS[run.status]?.includes(next)) throw Object.assign(new Error(`Illegal Test Lab transition ${run.status} → ${next}.`), { code: 'ILLEGAL_TRANSITION' });
    run.status = next;
    run.updatedAt = new Date(now()).toISOString();
  }

  function owned(testRunId, sessionId) {
    const run = runs.get(testRunId);
    if (!run || run.sessionId !== sessionId) return null;
    if (now() - Date.parse(run.createdAt) > ttlMs && ['DRAFT', 'AWAITING_APPROVAL', 'APPROVED'].includes(run.status)) {
      transition(run, 'EXPIRED'); run.approvalStatus = 'expired'; run.approvalToken = null;
    }
    return run;
  }

  function create({ sessionId, requestedObjective }) {
    const createdAt = new Date(now()).toISOString();
    const run = {
      testRunId: crypto.randomUUID(), sessionId, status: 'DRAFT', requestedObjective,
      scenarioId: null, proposedPlan: null, approvedPlanHash: null, approvalStatus: 'pending',
      approvalTimestamp: null, executionStartedAt: null, executionCompletedAt: null,
      observations: [], predictionMetadata: null, diagnosticFindings: null, evaluation: null,
      errors: [], agentRuns: [], createdAt, updatedAt: createdAt,
      approvalToken: null, approvalExpiresAt: null, executionAuthorizationConsumedAt: null
    };
    runs.set(run.testRunId, run);
    return run;
  }

  function setPlan(testRunId, sessionId, plan) {
    const run = owned(testRunId, sessionId);
    if (!run || run.status !== 'DRAFT') throw Object.assign(new Error('Run is missing, not owned by this session, or no longer editable.'), { code: 'RUN_NOT_EDITABLE' });
    run.scenarioId = plan.scenarioId;
    run.proposedPlan = structuredClone(plan);
    transition(run, 'AWAITING_APPROVAL');
    return run;
  }

  function approve(testRunId, sessionId) {
    const run = owned(testRunId, sessionId);
    if (!run || run.status !== 'AWAITING_APPROVAL' || !run.proposedPlan) throw Object.assign(new Error('This run is not awaiting approval.'), { code: 'NOT_AWAITING_APPROVAL' });
    run.approvedPlanHash = hashPlan(run.proposedPlan);
    run.approvalStatus = 'approved';
    run.approvalTimestamp = new Date(now()).toISOString();
    run.approvalExpiresAt = now() + approvalTtlMs;
    run.approvalToken = crypto.randomBytes(32).toString('hex');
    transition(run, 'APPROVED');
    return run;
  }

  function cancel(testRunId, sessionId) {
    const run = owned(testRunId, sessionId);
    if (!run || !['DRAFT', 'AWAITING_APPROVAL', 'APPROVED'].includes(run.status)) throw Object.assign(new Error('This run cannot be cancelled before execution.'), { code: 'RUN_CANNOT_CANCEL' });
    run.approvalStatus = 'cancelled'; run.approvalToken = null; transition(run, 'CANCELLED');
    return run;
  }

  function beginExecution(testRunId, sessionId, scenarioId, parameters) {
    const run = owned(testRunId, sessionId);
    if (!run || run.status !== 'APPROVED' || run.approvalStatus !== 'approved') throw Object.assign(new Error('Verified human approval is required before execution.'), { code: 'APPROVAL_REQUIRED' });
    if (now() >= run.approvalExpiresAt) { run.approvalStatus = 'expired'; run.approvalToken = null; transition(run, 'EXPIRED'); throw Object.assign(new Error('Approval expired; request a new plan.'), { code: 'APPROVAL_EXPIRED' }); }
    if (!run.approvalToken || run.executionAuthorizationConsumedAt || run.approvedPlanHash !== hashPlan(run.proposedPlan)) throw Object.assign(new Error('Approval is invalid, already consumed, or does not match the approved plan.'), { code: 'APPROVAL_INVALID' });
    if (run.scenarioId !== scenarioId || canonical(run.proposedPlan.parameters) !== canonical(parameters)) throw Object.assign(new Error('Execution request does not match the approved scenario and parameters.'), { code: 'PLAN_MISMATCH' });
    if (!SCENARIOS[scenarioId]?.supported) throw Object.assign(new Error(SCENARIOS[scenarioId]?.reason || 'Unsupported scenario.'), { code: 'UNSUPPORTED_SCENARIO' });
    run.executionAuthorizationConsumedAt = new Date(now()).toISOString();
    run.approvalToken = null; transition(run, 'RUNNING'); run.executionStartedAt = new Date(now()).toISOString();
    return run;
  }

  function safe(run) {
    if (!run) return null;
    const { approvalToken, ...publicRun } = run;
    return structuredClone(publicRun);
  }

  return { create, owned, setPlan, approve, cancel, beginExecution, transition, safe, all: () => [...runs.values()].map(safe) };
}

function validatePlan(plan, objective) {
  if (!plan || plan.scenarioId !== 'normal_operation' || typeof plan.objective !== 'string' || !plan.objective.trim() || plan.objective.length > 300 || typeof objective !== 'string') throw Object.assign(new Error('Planner proposal does not match a supported test plan.'), { code: 'INVALID_PLAN' });
  const scenario = SCENARIOS[plan.scenarioId];
  if (!scenario?.supported) throw Object.assign(new Error(scenario?.reason || 'Unsupported test scenario.'), { code: 'UNSUPPORTED_SCENARIO' });
  if (!plan.parameters || typeof plan.parameters !== 'object' || Array.isArray(plan.parameters)) throw Object.assign(new Error('Invalid scenario parameters.'), { code: 'INVALID_PARAMETERS' });
  const rawDuration = plan.parameters.durationSeconds ?? plan.parameters.duration_seconds ?? plan.parameters.duration;
  const duration = typeof rawDuration === 'number' ? rawDuration : (typeof rawDuration === 'string' && /^\d+$/.test(rawDuration.trim()) ? parseInt(rawDuration.trim(), 10) : NaN);
  if (!Number.isInteger(duration)) throw Object.assign(new Error('Invalid scenario parameters: durationSeconds must be an integer.'), { code: 'INVALID_PARAMETERS' });
  if (duration < scenario.parameters.durationSeconds.min || duration > scenario.parameters.durationSeconds.max) throw Object.assign(new Error('durationSeconds is outside the supported range.'), { code: 'INVALID_PARAMETERS' });
  for (const field of ['expectedObservations', 'acceptanceCriteria', 'abortConditions']) if (!Array.isArray(plan[field]) || plan[field].length === 0 || plan[field].length > 8 || !plan[field].every(x => typeof x === 'string' && x.length <= 200)) throw Object.assign(new Error(`Invalid plan field ${field}.`), { code: 'INVALID_PLAN' });
  if (typeof plan.rationale !== 'string' || !plan.rationale.trim() || plan.rationale.length > 500) throw Object.assign(new Error('Invalid planner rationale.'), { code: 'INVALID_PLAN' });
  return { scenarioId: plan.scenarioId, objective: plan.objective.trim(), parameters: { durationSeconds: duration }, preconditions: [...scenario.preconditions], expectedObservations: [...plan.expectedObservations], acceptanceCriteria: [...plan.acceptanceCriteria], abortConditions: [...plan.abortConditions], rationale: plan.rationale.trim(), maxDurationMs: duration * 1000, requiredEvidence: [...scenario.requiredEvidence] };
}

module.exports = { SCENARIOS, TRANSITIONS, canonical, hashPlan, createTestLabStore, validatePlan };
