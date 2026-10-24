'use strict';

const { SCENARIOS, validatePlan } = require('./testLabStore');
const { createTestLabAgent, configuredModels } = require('./testLabAgents');

function declarations(names) {
  return names.map(name => ({
    name,
    description: `Use the scoped ${name.replaceAll('_', ' ')} Test Lab operation. Arguments are validated by the server.`,
    parametersJsonSchema: { type: 'object', properties: {}, additionalProperties: false }
  }));
}

function createTestLabWorkflow({ store, getSnapshot, client, apiKey, logger = console, preconditions = () => ({ allowed: true }), executeScenario } = {}) {
  if (!store || typeof getSnapshot !== 'function') throw new TypeError('Test Lab store and snapshot provider are required.');
  if (typeof executeScenario !== 'function') throw new TypeError('A simulator execution adapter is required.');
  const models = configuredModels();
  const agents = {};
  const runtime = new Map();

  function makeAgent(role, tools) {
    agents[role] = createTestLabAgent(role, {
      client, apiKey, model: models[role], logger,
      toolset: { declarations: declarations(tools), execute: (name, args) => {
        if (!tools.includes(name) || args == null || typeof args !== 'object' || Array.isArray(args)) throw new Error(`Invalid ${role} tool call: ${name}`);
        const registered = runtime.get(role);
        if (!registered || !Object.hasOwn(registered, name)) throw new Error(`Tool is not available for ${role}: ${name}`);
        return registered[name](args);
      } }
    });
  }

  makeAgent('coordinator', ['delegate_plan', 'request_diagnostic', 'get_run_summary', 'delegate_evaluation', 'get_workflow_status']);
  makeAgent('planner', ['list_scenarios', 'get_scenario', 'check_preconditions']);
  makeAgent('diagnostic', ['read_telemetry', 'read_diagnostics', 'read_prediction', 'read_run_observations']);
  makeAgent('executor', ['get_approved_run_spec', 'execute_approved_run', 'read_execution_status', 'read_run_observations', 'request_authorized_abort']);
  makeAgent('evaluator', ['read_final_evidence', 'read_approved_plan', 'read_run_observations', 'read_diagnostics', 'read_prediction', 'read_deterministic_evaluation']);

  async function plan(run, current) {
    const plannerRuntime = {
      list_scenarios: () => Object.values(SCENARIOS).map(({ id, label, supported, reason }) => ({ id, label, supported, ...(reason ? { reason } : {}) })),
      get_scenario: () => SCENARIOS.normal_operation,
      check_preconditions: () => preconditions(current),
      read_telemetry: () => current.telemetry,
      read_diagnostics: () => current.diagnostics
    };
    runtime.set('planner', plannerRuntime);
    const output = await agents.planner.run(
      'Propose a normal-operation simulated test for the requested objective using the supplied verified scenario definition, current snapshot telemetry, diagnostics, and precondition check. In your JSON response, set parameters to {"durationSeconds": 10} unless the requested objective specifies another duration between 5 and 30 seconds. Return your proposed plan as a JSON object matching the schema.',
      {
        requestedObjective: run.requestedObjective,
        supportedScenario: SCENARIOS.normal_operation,
        unsupportedScenario: SCENARIOS.fault_injection,
        currentTelemetry: current.telemetry,
        currentDiagnostics: current.diagnostics,
        diagnosticFindings: run.diagnosticFindings,
        preconditions: preconditions(current)
      }
    );
    run.agentRuns.push(output.metadata);
    const planResult = validatePlan(output.output, run.requestedObjective);
    const readiness = preconditions(current);
    if (!readiness.allowed) throw Object.assign(new Error(`Test preconditions are not satisfied: ${readiness.reasons.join('; ')}`), { code: 'PRECONDITION_FAILED' });
    return planResult;
  }

  function specialistEvidence(role, run, snapshot) {
    return {
      read_telemetry: () => snapshot.telemetry,
      read_diagnostics: () => snapshot.diagnostics,
      read_prediction: () => snapshot.prediction,
      read_run_observations: () => run.observations,
      read_final_evidence: () => ({ plan: run.proposedPlan, observations: run.observations, evaluation: run.evaluation, diagnosticFindings: run.diagnosticFindings }),
      read_approved_plan: () => run.proposedPlan,
      read_deterministic_evaluation: () => run.evaluation,
      get_approved_run_spec: () => ({ testRunId: run.testRunId, scenarioId: run.scenarioId, plan: run.proposedPlan, approvalStatus: run.approvalStatus, approvedPlanHash: run.approvedPlanHash }),
      read_execution_status: () => ({ status: run.status, observations: run.observations, errors: run.errors }),
      request_authorized_abort: () => ({ available: false, reason: 'Normal observation window has no asynchronous simulator operation to abort.' })
    };
  }

  async function runDiagnostic(run, mode, snapshot) {
    runtime.set('diagnostic', specialistEvidence('diagnostic', run, snapshot));
    const result = await agents.diagnostic.run(mode === 'before' ? 'Assess whether current read-only evidence supports this approved normal-operation test.' : 'Analyze the recorded observations and any available diagnostics and prediction metadata. Call all needed read tools together in one response, then return JSON.', {
      testRunId: run.testRunId, phase: mode,
      plan: run.proposedPlan,
      telemetry: snapshot.telemetry, diagnostics: snapshot.diagnostics, predictionMetadata: snapshot.prediction
    });
    run.agentRuns.push(result.metadata);
    run.diagnosticFindings = result.output;
    return result.output;
  }

  function evaluateDeterministically(run) {
    const observations = run.observations;
    if (!observations.length) return { status: 'INCONCLUSIVE', criteria: ['No telemetry observations were recorded.'] };
    if (observations.some(x => x.safety?.tripped || Object.values(x.interlocks || {}).some(Boolean))) return { status: 'FAIL', criteria: ['A safety trip or simulator interlock occurred during the test.'] };
    const expectedCount = run.proposedPlan.parameters.durationSeconds;
    if (observations.length < Math.max(1, Math.floor(expectedCount / 3))) return { status: 'INCONCLUSIVE', criteria: ['Too few observations were recorded to evaluate the approved duration.'] };
    return { status: 'PASS', criteria: ['Telemetry was recorded throughout the observation window.', 'No safety trip or simulator interlock was recorded.'] };
  }

  async function execute(run, sessionId, storeApi) {
    const gateSnapshot = await getSnapshot();
    const spec = { scenarioId: run.scenarioId, parameters: run.proposedPlan.parameters };
    let approvedSpecRead = false;
    let executionRequested = false;
    runtime.set('executor', {
      ...specialistEvidence('executor', run, gateSnapshot),
      get_approved_run_spec: () => { approvedSpecRead = true; return specialistEvidence('executor', run, gateSnapshot).get_approved_run_spec(); },
      execute_approved_run: async () => {
        if (!approvedSpecRead) throw Object.assign(new Error('Executor must retrieve the approved specification before requesting execution.'), { code: 'SPEC_READ_REQUIRED' });
        if (executionRequested) throw Object.assign(new Error('This execution request has already been consumed.'), { code: 'DUPLICATE_EXECUTION' });
        executionRequested = true;
        if (run.status !== 'APPROVED' || run.approvalStatus !== 'approved') throw Object.assign(new Error('Verified approval is required before simulator execution.'), { code: 'APPROVAL_REQUIRED' });
        const current = await getSnapshot();
        const runtimeGate = preconditions(current);
        if (!runtimeGate.allowed) throw Object.assign(new Error(`Execution blocked by runtime safety gate: ${runtimeGate.reasons.join('; ')}`), { code: 'SAFETY_GATE_BLOCKED' });
        storeApi.beginExecution(run.testRunId, sessionId, run.scenarioId, run.proposedPlan.parameters);
        const result = await executeScenario(spec);
        if (!result || result.status !== 'completed' || !Array.isArray(result.observations)) throw new Error('Simulator adapter returned invalid execution evidence.');
        run.observations.push(...result.observations);
        return { status: 'completed', summary: `Recorded ${result.observations.length} simulator observations.`, startedAt: result.startedAt, completedAt: result.completedAt };
      }
    });

    const began = run;
    let adapterResult;
    try {
      const call = await agents.executor.run('For this request, first invoke get_approved_run_spec, then invoke execute_approved_run exactly once with no arguments. After it returns, report that tool result. Never summarize or claim successful execution without the result.', {
        testRunId: began.testRunId, approvedScenarioId: began.scenarioId,
        approvedParameters: began.proposedPlan.parameters, approvedPlanHash: began.approvedPlanHash,
        workflowInstructions: ['Call get_approved_run_spec first.', 'Call execute_approved_run once and only once.', 'Return its exact completed, running, aborted or error status.']
      });
      began.agentRuns.push(call.metadata);
      adapterResult = call.output;
      if (adapterResult.runId !== began.testRunId) throw Object.assign(new Error('Executor returned a result for a different test run.'), { code: 'RUN_ID_MISMATCH' });
      if (adapterResult.status === 'error') throw new Error(adapterResult.summary || 'Executor reported failure.');
      if (!executionRequested || began.status === 'APPROVED') throw Object.assign(new Error('Executor returned without requesting the approved simulator operation.'), { code: 'EXECUTION_NOT_REQUESTED' });
      if (adapterResult.status !== 'completed') throw Object.assign(new Error(`Executor reported ${adapterResult.status}; completed evidence is unavailable.`), { code: adapterResult.status === 'aborted' ? 'ABORTED' : 'EXECUTION_ERROR' });
      if (!began.observations.length) throw new Error('Executor completed without recording backend observations.');
      began.executionCompletedAt = new Date().toISOString();
      storeApi.transition(began, 'EVALUATING');
    } catch (error) {
      if (Array.isArray(error.observations)) began.observations.push(...error.observations);
      began.errors.push({ message: error.message, code: error.code || 'EXECUTION_ERROR', at: new Date().toISOString() });
      began.executionCompletedAt = new Date().toISOString();
      if (began.status === 'RUNNING') storeApi.transition(began, error.code === 'ABORTED' ? 'ABORTED' : 'FAILED');
      else if (began.status === 'APPROVED' && ['SAFETY_GATE_BLOCKED', 'APPROVAL_REQUIRED'].includes(error.code)) {
        began.executionCompletedAt = new Date().toISOString();
        storeApi.transition(began, 'FAILED');
      }
      throw error;
    }

    const postSnapshot = await getSnapshot();
    began.predictionMetadata = postSnapshot.prediction;
    await runDiagnostic(began, 'after', { ...postSnapshot, telemetry: began.observations.at(-1) || postSnapshot.telemetry });
    began.evaluation = evaluateDeterministically(began);

    runtime.set('evaluator', specialistEvidence('evaluator', began, postSnapshot));
    try {
      const report = await agents.evaluator.run('Review the deterministic evaluation and test evidence. Call read_final_evidence once (or all needed tools together in one turn), then return your final JSON evaluation report with summary, comparisons, and limitations.', {
        testRunId: began.testRunId, plan: began.proposedPlan, execution: adapterResult,
        observations: began.observations, diagnostics: began.diagnosticFindings,
        predictionMetadata: began.predictionMetadata, deterministicEvaluation: began.evaluation
      });
      began.agentRuns.push(report.metadata);
      began.evaluation.report = report.output;
    } catch (evalError) {
      logger.warn?.('[AI Test Lab] Evaluator agent failed; using deterministic report fallback', { error: evalError.message });
      began.errors.push({ message: `Evaluator agent: ${evalError.message}`, code: 'EVALUATOR_AGENT_ERROR', at: new Date().toISOString() });
      began.evaluation.report = {
        summary: `Deterministic evaluation completed with status: ${began.evaluation.status}. Verified ${began.observations.length} simulator observation samples against acceptance criteria.`,
        comparisons: began.evaluation.criteria || ['Telemetry was recorded throughout the observation window.'],
        limitations: [`Evaluator report notice: ${evalError.message}`]
      };
    }
    storeApi.transition(began, 'COMPLETED');
    return began;
  }

  async function coordinatePlan(run, snapshot) {
    logger.info?.('[AI Test Lab] Workflow stage started: coordinatePlan', { role: 'coordinator', testRunId: run.testRunId });
    let plannerDelegated = false;
    const coordinatorRuntime = {
      delegate_plan: () => {
        if (plannerDelegated) {
          return {
            delegated: true,
            role: 'planner',
            testRunId: run.testRunId,
            status: 'ALREADY_DELEGATED',
            message: 'Planning has already been delegated to Test Planner. Do not call delegate_plan again; return your final JSON response with nextAction: "plan".'
          };
        }
        plannerDelegated = true;
        return {
          delegated: true,
          role: 'planner',
          testRunId: run.testRunId,
          status: 'DELEGATED_TO_PLANNER',
          message: 'Planning successfully delegated to Test Planner. Do not call any further tools. Return your terminal JSON response with nextAction: "plan".'
        };
      },
      request_diagnostic: () => ({ delegated: true, role: 'diagnostic' }),
      get_run_summary: () => ({ testRunId: run.testRunId, status: run.status, scenarioId: run.scenarioId }),
      delegate_evaluation: () => ({ delegated: true, role: 'evaluator' }),
      get_workflow_status: () => ({ status: run.status, approvalStatus: run.approvalStatus })
    };
    runtime.set('coordinator', coordinatorRuntime);
    const coordinator = await agents.coordinator.run('Classify the request and delegate the supported planning task to Test Planner. Call delegate_plan exactly once, then return JSON with nextAction set to "plan". Do not call any other tools.', {
      testRunId: run.testRunId, requestedObjective: run.requestedObjective,
      scenarioIds: Object.keys(SCENARIOS), currentSafety: snapshot.telemetry?.safety
    });
    run.agentRuns.push(coordinator.metadata);
    logger.info?.('[AI Test Lab] Coordinator response', { nextAction: coordinator.output?.nextAction, hasDelegate: plannerDelegated });
    if (!plannerDelegated) throw Object.assign(new Error('Coordinator did not delegate planning to Test Planner.'), { code: 'PLANNER_DELEGATION_REQUIRED' });
    if (coordinator.output.nextAction && coordinator.output.nextAction !== 'plan') throw Object.assign(new Error('Coordinator did not authorize the planning transition.'), { code: 'COORDINATOR_REJECTED' });
    runtime.set('diagnostic', specialistEvidence('diagnostic', run, snapshot));
    const diagnostic = await agents.diagnostic.run('Perform a read-only pre-test context check. Call all needed read tools together in one response, then return JSON. Report current safety and data limitations without recommending or performing control changes.', {
      testRunId: run.testRunId, phase: 'before', objective: run.requestedObjective,
      telemetry: snapshot.telemetry, diagnostics: snapshot.diagnostics, predictionMetadata: snapshot.prediction
    });
    run.agentRuns.push(diagnostic.metadata);
    run.diagnosticFindings = diagnostic.output;
    return plan(run, snapshot);
  }

  return { agents, models, plan, execute, runDiagnostic, evaluateDeterministically, coordinatePlan, getAgentMetadata: () => Object.values(agents).map(({ name, role, model, tools }) => ({ name, role, model, tools })) };
}

module.exports = { createTestLabWorkflow };
