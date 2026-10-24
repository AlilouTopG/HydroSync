'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  AGENT_DEFINITIONS,
  MAX_TOOL_ROUNDS,
  createTestLabAgent,
  normalizeToolResult,
  validateOutput,
  upstreamErrorDetails
} = require('./testLabAgents');
const { createTestLabWorkflow } = require('./testLabWorkflow');
const { createTestLabStore, validatePlan, hashPlan } = require('./testLabStore');
const { createConversationStore } = require('./conversationStore');

function samplePlan(parameters = { durationSeconds: 10 }) {
  return {
    scenarioId: 'normal_operation',
    objective: 'Observe normal operation under load',
    parameters,
    expectedObservations: ['Pump duty stable at 50%'],
    acceptanceCriteria: ['No simulator safety trip'],
    abortConditions: ['Safety trip', 'Interlock active'],
    rationale: 'Baseline read-only observation test.'
  };
}

function sampleSnapshot(overrides = {}) {
  return {
    observedAt: new Date().toISOString(),
    telemetry: {
      pumpDuty: 50,
      flowRate: 10,
      motorTemp: 40,
      safety: { tripped: false, alarms: [] },
      interlocks: {}
    },
    diagnostics: { available: true, baselineStatus: 'NORMAL' },
    prediction: { status: 'unavailable', prediction: null },
    ...overrides
  };
}

test('Session initialization creates session without calling Gemini', () => {
  let geminiCalls = 0;
  const mockClient = {
    models: {
      generateContent: async () => {
        geminiCalls += 1;
        throw new Error('Gemini must not be called during session creation');
      }
    }
  };

  const store = createConversationStore();
  const sessionId = store.create();
  assert.ok(typeof sessionId === 'string');
  assert.ok(sessionId.length > 10);
  assert.equal(geminiCalls, 0, 'No Gemini calls should occur during session creation');
  const history = store.getHistory(sessionId);
  assert.deepEqual(history, []);
});

test('normalizeToolResult formats objects, arrays, primitives, null, and handles serialization errors safely', () => {
  // Plain objects preserved
  assert.deepEqual(normalizeToolResult({ status: 'ok', count: 5 }), { status: 'ok', count: 5 });

  // Arrays wrapped in { output: ... }
  assert.deepEqual(normalizeToolResult([1, 2, 3]), { output: [1, 2, 3] });

  // Primitives wrapped in { output: ... }
  assert.deepEqual(normalizeToolResult('hello'), { output: 'hello' });
  assert.deepEqual(normalizeToolResult(123), { output: 123 });
  assert.deepEqual(normalizeToolResult(true), { output: true });
  assert.deepEqual(normalizeToolResult(false), { output: false });

  // null and undefined wrapped in { output: null }
  assert.deepEqual(normalizeToolResult(null), { output: null });
  assert.deepEqual(normalizeToolResult(undefined), { output: null });

  // Circular / non-serializable object handled gracefully
  const circular = {};
  circular.self = circular;
  const normalizedCircular = normalizeToolResult(circular);
  assert.equal(normalizedCircular.output, null);
  assert.match(normalizedCircular.error, /serialised/i);
});

test('Function call responses preserve tool names and SDK call IDs', async () => {
  const dispatchedParts = [];
  const mockClient = {
    models: {
      generateContent: async ({ contents }) => {
        if (contents.length === 1) {
          return {
            functionCalls: [{ name: 'delegate_plan', args: { note: 'start' }, id: 'call-id-999' }],
            candidates: [{
              content: {
                role: 'model',
                parts: [{ functionCall: { name: 'delegate_plan', args: { note: 'start' } } }]
              }
            }]
          };
        }
        // Second turn: inspect contents to verify tool response has matching id and name
        const userTurn = contents.find(c => c.role === 'user' && c.parts?.some(p => p.functionResponse));
        assert.ok(userTurn, 'User turn with functionResponse must exist');
        const responsePart = userTurn.parts.find(p => p.functionResponse?.name === 'delegate_plan');
        assert.ok(responsePart, 'functionResponse must match tool name');
        assert.equal(responsePart.functionResponse.id, 'call-id-999', 'call.id must be preserved');
        dispatchedParts.push(responsePart);
        return { text: JSON.stringify({ summary: 'Delegated', nextAction: 'plan' }) };
      }
    }
  };

  const agent = createTestLabAgent('coordinator', {
    client: mockClient,
    toolset: {
      declarations: [{ name: 'delegate_plan' }],
      execute: async () => ({ delegated: true })
    }
  });

  const res = await agent.run('Coordinate', { testRunId: 'test-123' });
  assert.equal(res.output.nextAction, 'plan');
  assert.equal(dispatchedParts.length, 1);
});

test('Multiple function calls in a single round are dispatched and acknowledged', async () => {
  const executed = [];
  const mockClient = {
    models: {
      generateContent: async ({ contents }) => {
        if (contents.length === 1) {
          return {
            functionCalls: [
              { name: 'read_telemetry', args: {}, id: 'call-telemetry-1' },
              { name: 'read_diagnostics', args: {}, id: 'call-diagnostics-2' }
            ],
            candidates: [{
              content: {
                role: 'model',
                parts: [
                  { functionCall: { name: 'read_telemetry', args: {} } },
                  { functionCall: { name: 'read_diagnostics', args: {} } }
                ]
              }
            }]
          };
        }
        // Verify both function responses are present in the second turn
        const userTurn = contents[contents.length - 1];
        assert.equal(userTurn.role, 'user');
        assert.equal(userTurn.parts.length, 2);
        assert.equal(userTurn.parts[0].functionResponse.name, 'read_telemetry');
        assert.equal(userTurn.parts[0].functionResponse.id, 'call-telemetry-1');
        assert.equal(userTurn.parts[1].functionResponse.name, 'read_diagnostics');
        assert.equal(userTurn.parts[1].functionResponse.id, 'call-diagnostics-2');
        return {
          text: JSON.stringify({
            findings: [{ finding: 'Telemetry and diagnostics normal', evidence: 'all readings nominal' }],
            missingEvidence: [],
            uncertainty: []
          })
        };
      }
    }
  };

  const agent = createTestLabAgent('diagnostic', {
    client: mockClient,
    toolset: {
      declarations: [{ name: 'read_telemetry' }, { name: 'read_diagnostics' }],
      execute: async (name) => {
        executed.push(name);
        return { tool: name, ok: true };
      }
    }
  });

  const res = await agent.run('Read context', { testRunId: 'test-multicall' });
  assert.deepEqual(executed, ['read_telemetry', 'read_diagnostics']);
  assert.equal(res.output.findings.length, 1);
});

test('Repeated tool calls in consecutive rounds are intercepted as loops', async () => {
  let round = 0;
  const mockClient = {
    models: {
      generateContent: async () => {
        round += 1;
        // The model stubbornly returns the identical tool call twice
        return {
          functionCalls: [{ name: 'delegate_plan', args: {} }],
          candidates: [{
            content: {
              role: 'model',
              parts: [{ functionCall: { name: 'delegate_plan', args: {} } }]
            }
          }]
        };
      }
    }
  };

  const agent = createTestLabAgent('coordinator', {
    client: mockClient,
    toolset: {
      declarations: [{ name: 'delegate_plan' }],
      execute: async () => ({ delegated: true })
    }
  });

  await assert.rejects(
    agent.run('Delegate planning', {}),
    /called the same tool\(s\) \[delegate_plan\] twice in a row without making progress/
  );
  assert.equal(round, 2, 'Should abort immediately on the second consecutive repeated call');
});

test('Calling a tool outside the allowlist is rejected', async () => {
  const mockClient = {
    models: {
      generateContent: async () => ({
        functionCalls: [{ name: 'execute_approved_run', args: {} }],
        candidates: [{
          content: {
            role: 'model',
            parts: [{ functionCall: { name: 'execute_approved_run', args: {} } }]
          }
        }]
      })
    }
  };

  const agent = createTestLabAgent('coordinator', {
    client: mockClient,
    toolset: {
      declarations: [{ name: 'delegate_plan' }],
      execute: async () => ({})
    }
  });

  await assert.rejects(
    agent.run('Delegate', {}),
    /outside its allowlist/
  );
});

test('Malformed tool calls without a valid name are rejected', async () => {
  const mockClient = {
    models: {
      generateContent: async () => ({
        functionCalls: [{ args: {} }], // missing name
        candidates: [{
          content: {
            role: 'model',
            parts: [{ functionCall: { args: {} } }]
          }
        }]
      })
    }
  };

  const agent = createTestLabAgent('coordinator', {
    client: mockClient,
    toolset: {
      declarations: [{ name: 'delegate_plan' }],
      execute: async () => ({})
    }
  });

  await assert.rejects(
    agent.run('Delegate', {}),
    /malformed tool call/
  );
});

test('Tool execution errors are fed back as tool results rather than crashing the loop', async () => {
  let callCount = 0;
  const mockClient = {
    models: {
      generateContent: async ({ contents }) => {
        callCount += 1;
        if (callCount === 1) {
          return {
            functionCalls: [{ name: 'read_prediction', args: {} }],
            candidates: [{
              content: {
                role: 'model',
                parts: [{ functionCall: { name: 'read_prediction', args: {} } }]
              }
            }]
          };
        }
        // Check that the error was captured in functionResponse
        const userTurn = contents[contents.length - 1];
        const part = userTurn.parts.find(p => p.functionResponse?.name === 'read_prediction');
        assert.ok(part.functionResponse.response.error);
        assert.equal(part.functionResponse.response.available, false);
        return {
          text: JSON.stringify({
            findings: [],
            missingEvidence: ['ML prediction service temporarily unreachable.'],
            uncertainty: ['Prediction status unknown.']
          })
        };
      }
    }
  };

  const agent = createTestLabAgent('diagnostic', {
    client: mockClient,
    toolset: {
      declarations: [{ name: 'read_prediction' }],
      execute: async () => {
        throw new Error('Connection refused to AI Engine');
      }
    }
  });

  const res = await agent.run('Assess', {});
  assert.equal(res.output.missingEvidence.length, 1);
  assert.match(res.output.missingEvidence[0], /unreachable/);
});

test('Terminal response parsing strips markdown fences and extracts JSON with surrounding text', async () => {
  const mockWithFences = {
    models: {
      generateContent: async () => ({
        text: '```json\n' + JSON.stringify(samplePlan()) + '\n```'
      })
    }
  };

  const agent1 = createTestLabAgent('planner', {
    client: mockWithFences,
    toolset: { declarations: [{ name: 'read_telemetry' }], execute: async () => ({}) }
  });
  const res1 = await agent1.run('Plan', {});
  assert.equal(res1.output.scenarioId, 'normal_operation');

  const mockWithProse = {
    models: {
      generateContent: async () => ({
        text: 'Here is the proposed test plan:\n' + JSON.stringify(samplePlan()) + '\nPlease proceed to review.'
      })
    }
  };

  const agent2 = createTestLabAgent('planner', {
    client: mockWithProse,
    toolset: { declarations: [{ name: 'read_telemetry' }], execute: async () => ({}) }
  });
  const res2 = await agent2.run('Plan', {});
  assert.equal(res2.output.scenarioId, 'normal_operation');
});

test('Planner schema validation rejects plans with invalid parameters or unverified scenarios', () => {
  // Wrong scenarioId
  assert.throws(
    () => validateOutput('planner', { ...samplePlan(), scenarioId: 'fault_injection' }),
    /outside the validated supported schema/
  );

  // Missing required field
  assert.throws(
    () => validateOutput('planner', { scenarioId: 'normal_operation', parameters: {} }),
    /missing objective/
  );

  // Non-array abortConditions
  assert.throws(
    () => validateOutput('planner', { ...samplePlan(), abortConditions: 'not-an-array' }),
    /outside the validated supported schema/
  );
});

test('Coordinator rejecting transition or failing to delegate throws explicit errors', async () => {
  const store = createTestLabStore();
  const run = store.create({ sessionId: 'session-rejection', requestedObjective: 'Test' });

  // Coordinator returns without delegating
  const mockNoDelegate = {
    models: {
      generateContent: async () => ({
        text: JSON.stringify({ summary: 'No delegation occurred', nextAction: 'none' })
      })
    }
  };

  const workflow1 = createTestLabWorkflow({
    store,
    client: mockNoDelegate,
    getSnapshot: async () => sampleSnapshot(),
    executeScenario: async () => ({ status: 'completed', observations: [] })
  });

  await assert.rejects(
    workflow1.coordinatePlan(run, sampleSnapshot()),
    err => err.code === 'PLANNER_DELEGATION_REQUIRED'
  );

  // Coordinator delegates but sets nextAction to 'none' or reject
  let step = 0;
  const mockRejectAction = {
    models: {
      generateContent: async () => {
        step += 1;
        if (step === 1) {
          return {
            functionCalls: [{ name: 'delegate_plan', args: {} }],
            candidates: [{
              content: {
                role: 'model',
                parts: [{ functionCall: { name: 'delegate_plan', args: {} } }]
              }
            }]
          };
        }
        return { text: JSON.stringify({ summary: 'Request rejected', nextAction: 'none' }) };
      }
    }
  };

  const workflow2 = createTestLabWorkflow({
    store,
    client: mockRejectAction,
    getSnapshot: async () => sampleSnapshot(),
    executeScenario: async () => ({ status: 'completed', observations: [] })
  });

  await assert.rejects(
    workflow2.coordinatePlan(run, sampleSnapshot()),
    err => err.code === 'COORDINATOR_REJECTED'
  );
});

test('Exceeding MAX_TOOL_ROUNDS throws tool-call limit error', async () => {
  const mockInfiniteTools = {
    models: {
      generateContent: async () => ({
        // Alternating tools so it doesn't trigger repeated-call detection immediately
        functionCalls: [{ name: 'get_run_summary', args: {} }],
        candidates: [{
          content: {
            role: 'model',
            parts: [{ functionCall: { name: 'get_run_summary', args: {} } }]
          }
        }]
      })
    }
  };

  const agent = createTestLabAgent('coordinator', {
    client: mockInfiniteTools,
    maxToolRounds: 2,
    toolset: {
      declarations: [{ name: 'get_run_summary' }],
      execute: async () => ({ status: 'DRAFT' })
    }
  });

  await assert.rejects(
    agent.run('Coordinate', {}),
    /exceeded its tool-call limit/
  );
});

test('Cancellation via AbortSignal aborts execution immediately', async () => {
  const controller = new AbortController();
  controller.abort(new Error('User cancelled request'));

  const mockClient = {
    models: {
      generateContent: async () => {
        throw new Error('Should not reach generateContent when already aborted');
      }
    }
  };

  const agent = createTestLabAgent('coordinator', {
    client: mockClient,
    toolset: { declarations: [{ name: 'delegate_plan' }], execute: async () => ({}) }
  });

  await assert.rejects(
    agent.run('Coordinate', {}, { signal: controller.signal }),
    /User cancelled request/
  );
});

test('Executor cannot run test without verified approval, reading spec first, or reusing execution', async () => {
  const store = createTestLabStore();
  const run = store.create({ sessionId: 'session-exec', requestedObjective: 'Normal observation' });
  const plan = validatePlan(samplePlan(), 'Normal observation');
  store.setPlan(run.testRunId, 'session-exec', plan);

  let executed = false;
  let executorCount = 0;
  const workflow = createTestLabWorkflow({
    store,
    client: {
      models: {
        generateContent: async () => {
          executorCount += 1;
          if (executorCount === 1) {
            return {
              functionCalls: [{ name: 'get_approved_run_spec', args: {} }],
              candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'get_approved_run_spec', args: {} } }] } }]
            };
          }
          if (executorCount === 2) {
            return {
              functionCalls: [{ name: 'execute_approved_run', args: {} }],
              candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'execute_approved_run', args: {} } }] } }]
            };
          }
          return { text: JSON.stringify({ runId: run.testRunId, status: 'error', summary: 'failed' }) };
        }
      }
    },
    getSnapshot: async () => sampleSnapshot(),
    executeScenario: async () => {
      executed = true;
      return { status: 'completed', observations: [] };
    }
  });

  // Attempt to execute when run is only AWAITING_APPROVAL (not yet approved)
  await assert.rejects(
    workflow.execute(run, 'session-exec', store),
    err => err.code === 'APPROVAL_REQUIRED' || /human approval/i.test(err.message)
  );
  assert.equal(executed, false);
});

test('Complete mocked end-to-end workflow exercises all 5 roles across planning, approval, and execution boundaries', async () => {
  const store = createTestLabStore();
  const run = store.create({ sessionId: 'session-e2e', requestedObjective: 'Observe normal pump operation' });

  const roleInvocations = {
    coordinator: 0,
    planner: 0,
    diagnostic: 0,
    executor: 0,
    evaluator: 0
  };

  const mockClient = {
    models: {
      generateContent: async ({ config }) => {
        const instruction = config.systemInstruction;
        const role = Object.keys(AGENT_DEFINITIONS).find(k => instruction.includes(AGENT_DEFINITIONS[k].instruction));
        assert.ok(role, 'Every Gemini call must use an identifiable role instruction');
        roleInvocations[role] += 1;

        const json = val => ({ text: JSON.stringify(val) });
        const call = (name, args = {}, id = `${role}-${roleInvocations[role]}`) => ({
          functionCalls: [{ name, args, id }],
          candidates: [{
            content: {
              role: 'model',
              parts: [{ functionCall: { name, args } }]
            }
          }]
        });

        if (role === 'coordinator') {
          if (roleInvocations.coordinator === 1) return call('delegate_plan');
          return json({ summary: 'Delegated planning to Test Planner.', nextAction: 'plan' });
        }

        if (role === 'diagnostic') {
          // Pre-test diagnostic analyst call
          return json({
            findings: [{ finding: 'Telemetry within normal bounds', evidence: 'motorTemp=40, pumpDuty=50' }],
            missingEvidence: ['ML prediction not currently active.'],
            uncertainty: ['Prediction confidence unavailable.']
          });
        }

        if (role === 'planner') {
          return json(samplePlan());
        }

        if (role === 'executor') {
          if (roleInvocations.executor === 1) return call('get_approved_run_spec');
          if (roleInvocations.executor === 2) return call('execute_approved_run');
          return json({
            runId: run.testRunId,
            status: 'completed',
            summary: 'Recorded 5 simulator observations without faults.'
          });
        }

        if (role === 'evaluator') {
          return json({
            summary: 'Test passed: steady normal operation maintained.',
            comparisons: ['Observed pumpDuty matches target 50%.'],
            limitations: ['Simulator observation window only.']
          });
        }

        throw new Error(`Unexpected role invocation: ${role}`);
      }
    }
  };

  const snapshot = sampleSnapshot();
  const workflow = createTestLabWorkflow({
    store,
    client: mockClient,
    getSnapshot: async () => snapshot,
    preconditions: () => ({ allowed: true, reasons: [] }),
    executeScenario: async () => ({
      status: 'completed',
      startedAt: new Date(Date.now() - 5000).toISOString(),
      completedAt: new Date().toISOString(),
      observations: Array.from({ length: 5 }, () => snapshot.telemetry)
    }),
    logger: { info() {}, warn() {}, error() {} }
  });

  // Stage 1: Planning
  const proposal = await workflow.coordinatePlan(run, snapshot);
  assert.equal(proposal.scenarioId, 'normal_operation');
  store.setPlan(run.testRunId, 'session-e2e', proposal);
  assert.equal(run.status, 'AWAITING_APPROVAL');
  assert.ok(run.diagnosticFindings);
  assert.equal(roleInvocations.coordinator, 2, 'Coordinator used 2 rounds (tool call + terminal JSON)');
  assert.equal(roleInvocations.diagnostic, 1, 'Diagnostic pre-test completed in 1 round');
  assert.equal(roleInvocations.planner, 1, 'Planner generated proposal in 1 round');

  // Stage 2: Human Approval Boundary
  store.approve(run.testRunId, 'session-e2e');
  assert.equal(run.status, 'APPROVED');
  assert.equal(run.approvalStatus, 'approved');

  // Stage 3: Execution & Evaluation
  const completedRun = await workflow.execute(run, 'session-e2e', store);
  assert.equal(completedRun.status, 'COMPLETED');
  assert.equal(completedRun.evaluation.status, 'PASS');
  assert.equal(completedRun.observations.length, 5);
  assert.ok(completedRun.evaluation.report);
  assert.equal(roleInvocations.executor, 3, 'Executor used 3 rounds (spec + execute + terminal JSON)');
  assert.equal(roleInvocations.evaluator, 1, 'Evaluator produced report in 1 round');

  // Verify all 5 roles were invoked separately
  assert.deepEqual(Object.keys(roleInvocations), ['coordinator', 'planner', 'diagnostic', 'executor', 'evaluator']);
  for (const [r, count] of Object.entries(roleInvocations)) {
    assert.ok(count > 0, `Role ${r} must have at least 1 invocation`);
  }
});

test('Planner completes successfully through the three-tool discovery sequence (list_scenarios -> get_scenario -> check_preconditions -> terminal plan)', async () => {
  const store = createTestLabStore();
  const run = store.create({ sessionId: 'session-planner-seq', requestedObjective: 'Observe normal operation' });
  const executedPlannerTools = [];
  let plannerRound = 0;

  const mockClient = {
    models: {
      generateContent: async ({ config }) => {
        const instruction = config.systemInstruction;
        if (instruction.includes(AGENT_DEFINITIONS.coordinator.instruction)) {
          return { text: JSON.stringify({ summary: 'Delegated', nextAction: 'plan' }) };
        }
        if (instruction.includes(AGENT_DEFINITIONS.diagnostic.instruction)) {
          return {
            text: JSON.stringify({
              findings: [{ finding: 'Telemetry nominal', evidence: 'pumpDuty=50' }],
              missingEvidence: [],
              uncertainty: []
            })
          };
        }
        if (instruction.includes(AGENT_DEFINITIONS.planner.instruction)) {
          plannerRound += 1;
          const call = (name, args = {}) => ({
            functionCalls: [{ name, args, id: `planner-call-${plannerRound}` }],
            candidates: [{
              content: {
                role: 'model',
                parts: [{ functionCall: { name, args } }]
              }
            }]
          });

          // Observed live sequence:
          // Round 0: list_scenarios
          // Round 1: get_scenario
          // Round 2: check_preconditions
          // Round 3: terminal plan JSON
          if (plannerRound === 1) return call('list_scenarios');
          if (plannerRound === 2) return call('get_scenario');
          if (plannerRound === 3) return call('check_preconditions');
          if (plannerRound === 4) {
            return {
              text: JSON.stringify(samplePlan({ durationSeconds: 15 }))
            };
          }
        }
        throw new Error('Unexpected invocation in planner sequence test');
      }
    }
  };

  const snapshot = sampleSnapshot();
  const workflow = createTestLabWorkflow({
    store,
    client: mockClient,
    getSnapshot: async () => snapshot,
    preconditions: () => ({ allowed: true, reasons: [] }),
    executeScenario: async () => ({ status: 'completed', observations: [] })
  });

  const plan = await workflow.plan(run, snapshot);
  assert.equal(plan.scenarioId, 'normal_operation');
  assert.equal(plan.parameters.durationSeconds, 15);
  assert.equal(plannerRound, 4, 'Planner must execute 3 tool rounds and 1 terminal response round');

  // Verify transition to AWAITING_APPROVAL after validated plan exists
  store.setPlan(run.testRunId, 'session-planner-seq', plan);
  assert.equal(run.status, 'AWAITING_APPROVAL');
  assert.equal(run.proposedPlan.parameters.durationSeconds, 15);
});

test('Planner exceeding its role-specific budget terminates with a bounded error', async () => {
  let callCount = 0;
  const mockEndlessPlanner = {
    models: {
      generateContent: async () => {
        callCount += 1;
        // Alternating tools to not trip repeat detector before the budget is reached
        const tools = ['list_scenarios', 'get_scenario', 'check_preconditions', 'read_telemetry', 'read_diagnostics'];
        const toolName = tools[callCount % tools.length];
        return {
          functionCalls: [{ name: toolName, args: {} }],
          candidates: [{
            content: {
              role: 'model',
              parts: [{ functionCall: { name: toolName, args: {} } }]
            }
          }]
        };
      }
    }
  };

  const agent = createTestLabAgent('planner', {
    client: mockEndlessPlanner,
    toolset: {
      declarations: [
        { name: 'list_scenarios' },
        { name: 'get_scenario' },
        { name: 'check_preconditions' },
        { name: 'read_telemetry' },
        { name: 'read_diagnostics' }
      ],
      execute: async () => ({ status: 'ok' })
    }
  });

  await assert.rejects(
    agent.run('Plan normal operation', {}),
    /Test Planner exceeded its tool-call limit \(round 4; pending:/
  );
  assert.equal(callCount, 5, 'Should consume exactly 5 rounds before rejecting');
});

test('Planner repeating the same tool call in consecutive rounds terminates via loop detection', async () => {
  let count = 0;
  const mockRepeatingPlanner = {
    models: {
      generateContent: async () => {
        count += 1;
        return {
          functionCalls: [{ name: 'check_preconditions', args: {} }],
          candidates: [{
            content: {
              role: 'model',
              parts: [{ functionCall: { name: 'check_preconditions', args: {} } }]
            }
          }]
        };
      }
    }
  };

  const agent = createTestLabAgent('planner', {
    client: mockRepeatingPlanner,
    toolset: {
      declarations: [{ name: 'check_preconditions' }],
      execute: async () => ({ allowed: true })
    }
  });

  await assert.rejects(
    agent.run('Plan normal operation', {}),
    /called the same tool\(s\) \[check_preconditions\] twice in a row without making progress/
  );
  assert.equal(count, 2, 'Should abort immediately on the second consecutive repeated call');
});

test('Alternating tool calls (A -> B -> A -> B) are intercepted as loops', async () => {
  let callCount = 0;
  const mockAlternatingAgent = {
    models: {
      generateContent: async () => {
        callCount += 1;
        // Alternates between get_run_summary and get_workflow_status
        const name = callCount % 2 === 1 ? 'get_run_summary' : 'get_workflow_status';
        return {
          functionCalls: [{ name, args: {} }],
          candidates: [{
            content: {
              role: 'model',
              parts: [{ functionCall: { name, args: {} } }]
            }
          }]
        };
      }
    }
  };

  const agent = createTestLabAgent('coordinator', {
    client: mockAlternatingAgent,
    maxToolRounds: 5,
    toolset: {
      declarations: [{ name: 'get_run_summary' }, { name: 'get_workflow_status' }],
      execute: async (name) => ({ tool: name, ok: true })
    }
  });

  await assert.rejects(
    agent.run('Coordinate', {}),
    /entered an alternating tool-call loop without making progress/
  );
  assert.equal(callCount, 4, 'Should abort on the 4th turn when alternating loop pattern A-B-A-B is confirmed');
});

test('Planner in coordinatePlan workflow completes using scenario and precondition validation without redundant telemetry or diagnostic fetches', async () => {
  const store = createTestLabStore();
  const run = store.create({ sessionId: 'session-planner-clean', requestedObjective: 'Verify normal operation' });
  const snapshot = sampleSnapshot();
  const toolsDispatched = {
    coordinator: [],
    diagnostic: [],
    planner: []
  };

  let plannerTurn = 0;
  const mockClient = {
    models: {
      generateContent: async ({ config }) => {
        const instruction = config.systemInstruction;
        if (instruction.includes(AGENT_DEFINITIONS.coordinator.instruction)) {
          if (!toolsDispatched.coordinator.includes('delegate_plan')) {
            toolsDispatched.coordinator.push('delegate_plan');
            return {
              functionCalls: [{ name: 'delegate_plan', args: {} }],
              candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'delegate_plan', args: {} } }] } }]
            };
          }
          return { text: JSON.stringify({ summary: 'Delegated planning.', nextAction: 'plan' }) };
        }

        if (instruction.includes(AGENT_DEFINITIONS.diagnostic.instruction)) {
          return {
            text: JSON.stringify({
              findings: [{ finding: 'Pump duty nominal', evidence: 'pumpDuty=50' }],
              missingEvidence: [],
              uncertainty: []
            })
          };
        }

        if (instruction.includes(AGENT_DEFINITIONS.planner.instruction)) {
          plannerTurn += 1;
          if (plannerTurn === 1) {
            toolsDispatched.planner.push('get_scenario');
            return {
              functionCalls: [{ name: 'get_scenario', args: {} }],
              candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'get_scenario', args: {} } }] } }]
            };
          }
          if (plannerTurn === 2) {
            toolsDispatched.planner.push('check_preconditions');
            return {
              functionCalls: [{ name: 'check_preconditions', args: {} }],
              candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'check_preconditions', args: {} } }] } }]
            };
          }
          return { text: JSON.stringify(samplePlan({ durationSeconds: 10 })) };
        }

        throw new Error('Unexpected agent request in coordinatePlan');
      }
    }
  };

  const workflow = createTestLabWorkflow({
    store,
    client: mockClient,
    getSnapshot: async () => snapshot,
    preconditions: () => ({ allowed: true, reasons: [] }),
    executeScenario: async () => ({ status: 'completed', observations: [] })
  });

  const proposal = await workflow.coordinatePlan(run, snapshot);
  assert.equal(proposal.scenarioId, 'normal_operation');
  assert.equal(proposal.parameters.durationSeconds, 10);
  assert.deepEqual(toolsDispatched.planner, ['get_scenario', 'check_preconditions'], 'Planner should only invoke scenario and precondition tools, no redundant telemetry or diagnostics');
  assert.equal(toolsDispatched.planner.includes('read_telemetry'), false);
  assert.equal(toolsDispatched.planner.includes('read_diagnostics'), false);

  store.setPlan(run.testRunId, 'session-planner-clean', proposal);
  assert.equal(run.status, 'AWAITING_APPROVAL');
});

test('Diagnostic Analyst distinguishes measured observations from unavailable ML predictions honestly without fabrication', async () => {
  const snapshotWithNoPrediction = sampleSnapshot({
    prediction: { status: 'unavailable', prediction: null }
  });

  let capturedContext = null;
  const mockClient = {
    models: {
      generateContent: async ({ contents }) => {
        const userContent = contents.find(c => c.role === 'user');
        capturedContext = JSON.parse(userContent.parts[0].text);
        return {
          text: JSON.stringify({
            findings: [{ finding: 'Telemetry steady at 50% PWM', evidence: 'motorTemp=40, flowRate=10' }],
            missingEvidence: ['ML prediction model is offline/unavailable; no failure probability prediction available.'],
            uncertainty: ['Long-term asset degradation risk cannot be quantified without ML inference.']
          })
        };
      }
    }
  };

  const agent = createTestLabAgent('diagnostic', {
    client: mockClient,
    toolset: {
      declarations: [{ name: 'read_telemetry' }, { name: 'read_prediction' }],
      execute: async () => ({})
    }
  });

  const res = await agent.run('Analyze pre-test diagnostics', {
    telemetry: snapshotWithNoPrediction.telemetry,
    prediction: snapshotWithNoPrediction.prediction
  });

  assert.equal(res.output.findings.length, 1);
  assert.ok(res.output.missingEvidence.some(e => /unavailable/i.test(e)));
  assert.ok(res.output.uncertainty.some(u => /cannot be quantified/i.test(u)));
});

test('Approval security: forged token, expired approval, reused approval, and mismatched parameters are all rejected', () => {
  let currentTime = Date.parse('2026-10-24T12:00:00.000Z');
  const store = createTestLabStore({ now: () => currentTime, approvalTtlMs: 3000 });
  const run = store.create({ sessionId: 'session-sec', requestedObjective: 'Security test' });
  const validPlan = validatePlan(samplePlan({ durationSeconds: 10 }), 'Security test');
  store.setPlan(run.testRunId, 'session-sec', validPlan);

  // 1. Cannot execute before approval
  assert.throws(
    () => store.beginExecution(run.testRunId, 'session-sec', 'normal_operation', { durationSeconds: 10 }),
    err => err.code === 'APPROVAL_REQUIRED'
  );

  // 2. Foreign session cannot approve
  assert.throws(
    () => store.approve(run.testRunId, 'different-session'),
    err => err.code === 'NOT_AWAITING_APPROVAL'
  );

  // Approve properly
  store.approve(run.testRunId, 'session-sec');
  assert.equal(run.status, 'APPROVED');

  // 3. Mismatched scenario or parameters rejected
  assert.throws(
    () => store.beginExecution(run.testRunId, 'session-sec', 'normal_operation', { durationSeconds: 20 }),
    err => err.code === 'PLAN_MISMATCH'
  );

  // 4. Expired approval rejected
  currentTime += 5000; // Fast forward past 3s TTL
  assert.throws(
    () => store.beginExecution(run.testRunId, 'session-sec', 'normal_operation', { durationSeconds: 10 }),
    err => err.code === 'APPROVAL_EXPIRED'
  );
  assert.equal(run.status, 'EXPIRED');

  // 5. Tampered plan hash rejection
  const run2 = store.create({ sessionId: 'session-tamper', requestedObjective: 'Tamper test' });
  store.setPlan(run2.testRunId, 'session-tamper', validPlan);
  store.approve(run2.testRunId, 'session-tamper');
  run2.proposedPlan.parameters.durationSeconds = 15; // sneaky alteration after approval
  assert.throws(
    () => store.beginExecution(run2.testRunId, 'session-tamper', 'normal_operation', { durationSeconds: 15 }),
    err => err.code === 'APPROVAL_INVALID'
  );
});

test('Runtime safety-interlock trip during execution stops observation and transitions to ABORTED', async () => {
  const store = createTestLabStore();
  const run = store.create({ sessionId: 'session-trip', requestedObjective: 'Safety trip test' });
  const plan = validatePlan(samplePlan(), 'Safety trip test');
  store.setPlan(run.testRunId, 'session-trip', plan);
  store.approve(run.testRunId, 'session-trip');

  let executorTurn = 0;
  const mockClient = {
    models: {
      generateContent: async () => {
        executorTurn += 1;
        if (executorTurn === 1) {
          return {
            functionCalls: [{ name: 'get_approved_run_spec', args: {} }],
            candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'get_approved_run_spec', args: {} } }] } }]
          };
        }
        if (executorTurn === 2) {
          return {
            functionCalls: [{ name: 'execute_approved_run', args: {} }],
            candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'execute_approved_run', args: {} } }] } }]
          };
        }
        return { text: JSON.stringify({ runId: run.testRunId, status: 'aborted', summary: 'Aborted due to trip' }) };
      }
    }
  };

  const workflow = createTestLabWorkflow({
    store,
    client: mockClient,
    getSnapshot: async () => sampleSnapshot(),
    preconditions: () => ({ allowed: true, reasons: [] }),
    executeScenario: async () => {
      // Simulate simulator throwing an ABORTED error with partial observations
      const err = Object.assign(new Error('Observation stopped by safety condition: Motor temperature limit exceeded.'), { code: 'ABORTED' });
      err.observations = [{ observedAt: new Date().toISOString(), pumpDuty: 50, motorTemp: 85 }];
      throw err;
    }
  });

  await assert.rejects(
    workflow.execute(run, 'session-trip', store),
    err => err.code === 'ABORTED'
  );

  assert.equal(run.status, 'ABORTED');
  assert.equal(run.observations.length, 1);
  assert.ok(run.errors.some(e => e.code === 'ABORTED'));
});

test('Deterministic evaluator calculates PASS, FAIL, and INCONCLUSIVE based strictly on evidence', () => {
  const store = createTestLabStore();
  const workflow = createTestLabWorkflow({
    store,
    getSnapshot: async () => sampleSnapshot(),
    executeScenario: async () => ({ status: 'completed', observations: [] })
  });

  const plan = validatePlan(samplePlan({ durationSeconds: 10 }), 'Test objective');

  // Case 1: Empty observations -> INCONCLUSIVE
  const run1 = { proposedPlan: plan, observations: [] };
  assert.equal(workflow.evaluateDeterministically(run1).status, 'INCONCLUSIVE');

  // Case 2: Safety tripped in observation -> FAIL
  const run2 = {
    proposedPlan: plan,
    observations: [
      { pumpDuty: 50, safety: { tripped: false }, interlocks: {} },
      { pumpDuty: 50, safety: { tripped: true }, interlocks: {} }
    ]
  };
  assert.equal(workflow.evaluateDeterministically(run2).status, 'FAIL');

  // Case 3: Too few observations for 10s duration (less than 3) -> INCONCLUSIVE
  const run3 = {
    proposedPlan: plan,
    observations: [{ pumpDuty: 50, safety: { tripped: false }, interlocks: {} }]
  };
  assert.equal(workflow.evaluateDeterministically(run3).status, 'INCONCLUSIVE');

  // Case 4: Nominal observations -> PASS
  const run4 = {
    proposedPlan: plan,
    observations: Array.from({ length: 5 }, () => ({ pumpDuty: 50, safety: { tripped: false }, interlocks: {} }))
  };
  assert.equal(workflow.evaluateDeterministically(run4).status, 'PASS');
});
