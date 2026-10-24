'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestLabStore, validatePlan, hashPlan } = require('./testLabStore');
const { AGENT_DEFINITIONS, configuredModels, createTestLabAgent, upstreamErrorDetails } = require('./testLabAgents');
const { createTestLabWorkflow } = require('./testLabWorkflow');

function plan(parameters = { durationSeconds: 10 }) {
  return {
    scenarioId: 'normal_operation', objective: 'Observe normal operation', parameters,
    expectedObservations: ['No simulator interlock'], acceptanceCriteria: ['Telemetry present'],
    abortConditions: ['Safety trip'], rationale: 'Safe read-only observation.'
  };
}

test('five Test Lab roles have distinct instructions, tool allowlists and configured models', () => {
  assert.deepEqual(Object.keys(AGENT_DEFINITIONS), ['coordinator', 'planner', 'diagnostic', 'executor', 'evaluator']);
  for (const role of Object.keys(AGENT_DEFINITIONS)) {
    assert.ok(AGENT_DEFINITIONS[role].instruction.length > 30);
    assert.ok(AGENT_DEFINITIONS[role].tools.length > 0);
  }
  assert.equal(new Set(Object.values(AGENT_DEFINITIONS).map(x => x.instruction)).size, 5);
  assert.deepEqual(configuredModels({}), {
    coordinator: 'gemini-3.5-flash-lite', planner: 'gemini-3.5-flash-lite', diagnostic: 'gemini-3.5-flash-lite',
    executor: 'gemini-3.5-flash-lite', evaluator: 'gemini-3.5-flash-lite'
  });
  assert.equal(configuredModels({ AI_TEST_LAB_PLANNER_MODEL: 'custom' }).planner, 'custom');
});

test('agent only accepts its own tools and validates structured model output', async () => {
  let requestConfig;
  const mock = { models: { generateContent: async ({ model, config }) => {
    assert.equal(model, 'planner-test');
    requestConfig = config;
    return { text: JSON.stringify(plan()) };
  } } };
  const agent = createTestLabAgent('planner', { client: mock, model: 'planner-test', toolset: { declarations: [{ name: 'read_telemetry' }], execute: async () => ({}) } });
  assert.equal((await agent.run('plan', { objective: 'observe' })).output.scenarioId, 'normal_operation');
  // responseMimeType and responseJsonSchema are intentionally absent: combining
  // JSON-mode with function calling causes models to loop on tool calls instead
  // of returning the terminal response. The schema is enforced via systemInstruction.
  assert.equal(Object.hasOwn(requestConfig, 'responseMimeType'), false);
  assert.equal(Object.hasOwn(requestConfig, 'responseJsonSchema'), false);
  assert.ok(requestConfig.systemInstruction, 'systemInstruction must be present');
  assert.match(requestConfig.systemInstruction, /JSON object/i, 'systemInstruction must request JSON output');
  assert.equal(Object.hasOwn(requestConfig, 'thinkingConfig'), false);
  assert.throws(() => createTestLabAgent('planner', { client: mock, toolset: { declarations: [{ name: 'execute_approved_run' }], execute: async () => ({}) } }), /exceeds its permission/);
});

test('Gemini upstream errors are logged with status and sanitized credential details', async () => {
  const failure = Object.assign(new Error('Request failed for key=secret-test-key'), { status: 400, code: 'INVALID_ARGUMENT' });
  const logs = [];
  const agent = createTestLabAgent('planner', {
    apiKey: 'secret-test-key', client: { models: { generateContent: async () => { throw failure; } } },
    toolset: { declarations: [{ name: 'read_telemetry' }], execute: async () => ({}) },
    logger: { error: (message, fields) => logs.push({ message, fields }), warn() {} }
  });
  await assert.rejects(agent.run('plan', { objective: 'observe' }), error => error === failure);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].fields.status, 400);
  assert.equal(logs[0].fields.code, 'INVALID_ARGUMENT');
  assert.doesNotMatch(JSON.stringify(logs), /secret-test-key/);
  assert.match(JSON.stringify(logs), /REDACTED/);
  const details = upstreamErrorDetails(Object.assign(new Error('Bad Authorization: Bearer abc123'), { code: 'ERR' }), 'other-key');
  assert.doesNotMatch(JSON.stringify(details), /abc123/);
});

test('approval binds exact plan hash, owner, expiration and single execution', () => {
  let now = Date.parse('2026-10-23T10:00:00.000Z');
  const store = createTestLabStore({ now: () => now, approvalTtlMs: 5000 });
  const run = store.create({ sessionId: 'session-a', requestedObjective: 'normal' });
  const approvedPlan = validatePlan(plan(), 'normal');
  store.setPlan(run.testRunId, 'session-a', approvedPlan);
  assert.notEqual(hashPlan(approvedPlan), hashPlan({ ...approvedPlan, objective: 'modified' }));
  assert.throws(() => store.beginExecution(run.testRunId, 'session-a', 'normal_operation', approvedPlan.parameters), /Verified human approval/);
  assert.throws(() => store.approve(run.testRunId, 'session-b'), /not awaiting approval/);
  store.approve(run.testRunId, 'session-a');
  assert.throws(() => store.beginExecution(run.testRunId, 'session-a', 'normal_operation', { durationSeconds: 9 }), /does not match/);
  store.beginExecution(run.testRunId, 'session-a', 'normal_operation', approvedPlan.parameters);
  assert.equal(run.status, 'RUNNING');
  assert.throws(() => store.beginExecution(run.testRunId, 'session-a', 'normal_operation', approvedPlan.parameters), /Verified human approval/);
});

test('cancelled, expired and unsupported plans cannot execute', () => {
  let now = Date.now();
  const store = createTestLabStore({ now: () => now, approvalTtlMs: 10 });
  const cancelled = store.create({ sessionId: 's', requestedObjective: 'normal' });
  store.setPlan(cancelled.testRunId, 's', validatePlan(plan(), 'normal'));
  store.cancel(cancelled.testRunId, 's');
  assert.throws(() => store.approve(cancelled.testRunId, 's'), /not awaiting approval/);
  const expiring = store.create({ sessionId: 's', requestedObjective: 'normal' });
  store.setPlan(expiring.testRunId, 's', validatePlan(plan(), 'normal'));
  store.approve(expiring.testRunId, 's');
  now += 11;
  assert.throws(() => store.beginExecution(expiring.testRunId, 's', 'normal_operation', { durationSeconds: 10 }), /Approval expired/);
  assert.throws(() => validatePlan({ ...plan(), scenarioId: 'fault_injection' }, 'fault'), /supported test plan/);
  assert.throws(() => validatePlan(plan({ durationSeconds: 31 }), 'normal'), /outside the supported range/);
});

test('five distinct model invocations complete the approved normal observation and deterministic report', async () => {
  const store = createTestLabStore();
  const run = store.create({ sessionId: 'session-live', requestedObjective: 'Observe normal pump operation' });
  const counts = Object.fromEntries(Object.keys(AGENT_DEFINITIONS).map(role => [role, 0]));
  const mockClient = { models: { generateContent: async ({ config }) => {
    const instruction = config.systemInstruction;
    const role = Object.keys(AGENT_DEFINITIONS).find(key => instruction.includes(AGENT_DEFINITIONS[key].instruction));
    assert.ok(role, 'each model request must use a distinct role instruction');
    counts[role] += 1;
    const json = value => ({ text: JSON.stringify(value) });
    const call = (name, args = {}) => ({ functionCalls: [{ name, args, id: `${role}-${counts[role]}` }], candidates: [{ content: { role: 'model', parts: [{ functionCall: { name, args } }] } }] });
    if (role === 'coordinator' && counts.coordinator === 1) return call('delegate_plan');
    if (role === 'coordinator') return json({ summary: 'Delegated planning.', nextAction: 'plan' });
    if (role === 'planner') return json(plan());
    if (role === 'diagnostic') return json({ findings: [{ finding: 'Safety clear', evidence: 'simulator state' }], missingEvidence: [], uncertainty: [] });
    if (role === 'executor' && counts.executor === 1) return call('get_approved_run_spec');
    if (role === 'executor' && counts.executor === 2) return call('execute_approved_run');
    if (role === 'executor') return json({ runId: run.testRunId, status: 'completed', summary: 'Four observations captured.' });
    if (role === 'evaluator') return json({ summary: 'Observed normal operation.', comparisons: ['No trip observed.'], limitations: ['Simulator only.'] });
    throw new Error(`Unexpected role ${role}`);
  } } };
  const snapshot = { observedAt: new Date().toISOString(), telemetry: { pumpDuty: 50, flowRate: 10, motorTemp: 40, safety: { tripped: false }, interlocks: {} }, diagnostics: { available: false }, prediction: { status: 'unavailable', prediction: null } };
  const workflow = createTestLabWorkflow({ store, client: mockClient, getSnapshot: async () => snapshot, preconditions: () => ({ allowed: true, reasons: [] }), executeScenario: async () => ({ status: 'completed', startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), observations: Array.from({ length: 4 }, () => snapshot.telemetry) }), logger: { warn() {} } });
  const proposed = await workflow.coordinatePlan(run, snapshot);
  store.setPlan(run.testRunId, 'session-live', proposed);
  store.approve(run.testRunId, 'session-live');
  await workflow.execute(run, 'session-live', store);
  assert.equal(run.status, 'COMPLETED');
  assert.equal(run.evaluation.status, 'PASS');
  assert.deepEqual(Object.keys(counts), ['coordinator', 'planner', 'diagnostic', 'executor', 'evaluator']);
  assert.ok(counts.coordinator && counts.planner && counts.diagnostic && counts.executor && counts.evaluator);
  assert.equal(run.observations.length, 4);
  assert.equal(run.agentRuns.filter(x => x.status === 'success').length, 6);
});
