'use strict';

const MODEL_DEFAULTS = Object.freeze({
  coordinator: ['AI_TEST_LAB_COORDINATOR_MODEL', 'gemini-3.5-flash-lite'],
  planner: ['AI_TEST_LAB_PLANNER_MODEL', 'gemini-3.5-flash-lite'],
  diagnostic: ['AI_TEST_LAB_DIAGNOSTIC_MODEL', 'gemini-3.5-flash-lite'],
  executor: ['AI_TEST_LAB_EXECUTOR_MODEL', 'gemini-3.5-flash-lite'],
  evaluator: ['AI_TEST_LAB_EVALUATOR_MODEL', 'gemini-3.5-flash-lite']
});

const AGENT_DEFINITIONS = Object.freeze({
  coordinator: {
    name: 'Test Coordinator',
    instruction: 'Coordinate exactly the supplied HydroSync simulated test workflow. Delegate planning, read-only diagnostics, execution, and reporting only through the supplied scoped tools. When delegating planning, call delegate_plan once. Upon receiving the tool response confirming delegation, return your terminal JSON object with nextAction: "plan". Never call delegate_plan more than once. Never invent results, approve a plan, or request execution outside an explicitly approved run. Return concise progress.',
    tools: ['delegate_plan', 'request_diagnostic', 'get_run_summary', 'delegate_evaluation', 'get_workflow_status'],
    schema: { type: 'object', required: ['summary'], properties: { summary: { type: 'string' }, nextAction: { type: 'string', enum: ['plan', 'await_approval', 'execute', 'evaluate', 'complete', 'none'] } }, additionalProperties: false }
  },
  planner: {
    name: 'Test Planner',
    instruction: 'Create a proposal only for a supported predefined simulated scenario. Verified scenario definitions, current telemetry, diagnostics, and deterministic preconditions are supplied in your context. You may discover scenarios using list_scenarios and get_scenario, and verify conditions with check_preconditions. Do not re-fetch telemetry or diagnostics already provided in context. Parameters, objective, expected observations, criteria, and abort conditions must match supplied scenario definitions. Set parameters to {"durationSeconds": 10} unless the objective requests another integer between 5 and 30. You cannot execute, control, or approve.',
    tools: ['list_scenarios', 'get_scenario', 'check_preconditions', 'read_telemetry', 'read_diagnostics'],
    schema: {
      type: 'object',
      required: ['scenarioId', 'objective', 'parameters', 'expectedObservations', 'acceptanceCriteria', 'abortConditions', 'rationale'],
      properties: {
        scenarioId: { type: 'string', enum: ['normal_operation'] },
        objective: { type: 'string' },
        parameters: {
          type: 'object',
          required: ['durationSeconds'],
          properties: {
            durationSeconds: { type: 'integer', minimum: 5, maximum: 30 }
          },
          additionalProperties: false
        },
        expectedObservations: { type: 'array', items: { type: 'string' } },
        acceptanceCriteria: { type: 'array', items: { type: 'string' } },
        abortConditions: { type: 'array', items: { type: 'string' } },
        rationale: { type: 'string' }
      },
      additionalProperties: false
    }
  },
  diagnostic: {
    name: 'Diagnostic Analyst',
    instruction: 'Analyze only the supplied current or recorded telemetry, diagnostic and prediction evidence. Distinguish measured observations, stale or current ML predictions, simulator ground truth, and your own finding. Identify missing or contradictory evidence and uncertainty. Read-only.',
    tools: ['read_telemetry', 'read_diagnostics', 'read_prediction', 'read_run_observations'],
    schema: { type: 'object', required: ['findings', 'missingEvidence', 'uncertainty'], properties: { findings: { type: 'array', items: { type: 'object', required: ['finding', 'evidence'], properties: { finding: { type: 'string' }, evidence: { type: 'string' } }, additionalProperties: false } }, missingEvidence: { type: 'array', items: { type: 'string' } }, uncertainty: { type: 'array', items: { type: 'string' } } }, additionalProperties: false }
  },
  executor: {
    name: 'Test Executor',
    instruction: 'Execute only the run specification returned by get_approved_run_spec. Request its one supported simulated scenario through execute_approved_run. The backend enforces approval, ownership, one-time use, parameter limits, runtime state and safety. Never claim execution succeeded unless the tool confirms it. No other control is permitted.',
    tools: ['get_approved_run_spec', 'execute_approved_run', 'read_execution_status', 'read_run_observations', 'request_authorized_abort'],
    schema: { type: 'object', required: ['runId', 'status', 'summary'], properties: { runId: { type: 'string' }, status: { type: 'string', enum: ['completed', 'running', 'aborted', 'error'] }, summary: { type: 'string' } }, additionalProperties: false }
  },
  evaluator: {
    name: 'Evaluator/Reporter',
    instruction: 'Explain the provided immutable approved plan, actual execution evidence, diagnostics and deterministic backend evaluation. You can call read_final_evidence once to inspect all evidence at once, or use the provided context, then return your structured JSON evaluation report with summary, comparisons, and limitations. You cannot change the final status, plan or safety state. Clearly report missing evidence and limitations.',
    tools: ['read_final_evidence', 'read_approved_plan', 'read_run_observations', 'read_diagnostics', 'read_prediction', 'read_deterministic_evaluation'],
    schema: { type: 'object', required: ['summary', 'comparisons', 'limitations'], properties: { summary: { type: 'string' }, comparisons: { type: 'array', items: { type: 'string' } }, limitations: { type: 'array', items: { type: 'string' } } }, additionalProperties: false }
  }
});

// Bounded role-specific tool-call round budgets.
// - coordinator: 3 rounds (delegate_plan -> terminal plan transition, with 1 buffer)
// - planner: 5 rounds (supports legitimate sequence: list_scenarios -> get_scenario -> check_preconditions -> terminal plan response)
// - diagnostic: 4 rounds (allows sequential or multi-tool readings -> terminal report)
// - executor: 4 rounds (get_approved_run_spec -> execute_approved_run -> terminal execution status, with 1 buffer)
// - evaluator: 5 rounds (allows reading final evidence / observations / diagnostics -> deterministic evaluation report)
const DEFAULT_ROLE_ROUND_BUDGETS = Object.freeze({
  coordinator: 3,
  planner: 5,
  diagnostic: 4,
  executor: 4,
  evaluator: 5
});

const MAX_TOOL_ROUNDS = Math.max(...Object.values(DEFAULT_ROLE_ROUND_BUDGETS));

function configuredModels(env = process.env) {
  return Object.fromEntries(Object.entries(MODEL_DEFAULTS).map(([role, [key, fallback]]) => [role, env[key] || fallback]));
}

function makeClient(apiKey = process.env.GEMINI_API_KEY) {
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set');
  const { GoogleGenAI } = require('@google/genai');
  return new GoogleGenAI({ apiKey });
}

function upstreamErrorDetails(error, apiKey = process.env.GEMINI_API_KEY) {
  const source = (error && typeof error === 'object') ? error : { message: String(error) };
  const cause = source?.cause || source?.error || source?.response?.data?.error;
  const sanitize = value => String(value || '')
    .replaceAll(apiKey || '\u0000', '[REDACTED]')
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
    .replace(/([?&](?:key|api_key|token)=)[^&\s]+/gi, '$1[REDACTED]');
  return {
    name: source?.name || cause?.name || null,
    status: source?.status || source?.httpStatusCode || source?.response?.status || cause?.status || cause?.httpStatusCode || cause?.response?.status || null,
    code: source?.code || source?.error?.code || cause?.code || cause?.error?.code || null,
    message: sanitize(source?.message || source?.error?.message || 'Gemini request failed.'),
    cause: cause ? {
      name: cause.name || null,
      status: cause.status || cause.httpStatusCode || cause.response?.status || null,
      code: cause.code || cause.error?.code || null,
      message: sanitize(cause.message || cause.error?.message)
    } : null
  };
}

function validateOutput(role, output) {
  const schema = AGENT_DEFINITIONS[role]?.schema;
  if (!schema || !output || typeof output !== 'object' || Array.isArray(output)) throw new Error('Invalid ' + role + ' agent output.');
  for (const key of schema.required) if (!Object.hasOwn(output, key)) throw new Error('Invalid ' + role + ' agent output: missing ' + key + '.');
  if (role === 'planner') {
    const p = output;
    if (p.scenarioId !== 'normal_operation' || typeof p.objective !== 'string' || !p.parameters || typeof p.parameters !== 'object' || Array.isArray(p.parameters) || !['expectedObservations', 'acceptanceCriteria', 'abortConditions'].every(k => Array.isArray(p[k]) && p[k].every(x => typeof x === 'string')) || typeof p.rationale !== 'string') throw new Error('Planner returned a plan outside the validated supported schema.');
    const rawSec = p.parameters.durationSeconds ?? p.parameters.duration_seconds ?? p.parameters.duration;
    const sec = typeof rawSec === 'number' ? rawSec : (typeof rawSec === 'string' && /^\d+$/.test(rawSec.trim()) ? parseInt(rawSec.trim(), 10) : NaN);
    if (Number.isInteger(sec)) {
      p.parameters = { durationSeconds: sec };
    }
  }
  if (role === 'diagnostic' && !['findings', 'missingEvidence', 'uncertainty'].every(k => Array.isArray(output[k]))) throw new Error('Diagnostic Analyst returned invalid structured findings.');
  if (role === 'evaluator' && !['comparisons', 'limitations'].every(k => Array.isArray(output[k]))) throw new Error('Evaluator returned invalid structured report.');
  return output;
}

// Safely build a functionResponse.response value that the Gemini SDK will accept.
// The SDK requires response to be a plain Record<string,unknown>.
// Arrays, primitives, null -> wrapped as { output: value }.
// Serialization errors -> { output: null, error: 'Tool result could not be serialised.' }.
function normalizeToolResult(result) {
  if (result === null || result === undefined) return { output: null };
  if (typeof result !== 'object' || Array.isArray(result)) return { output: result };
  try {
    JSON.stringify(result);
    return result;
  } catch (_) {
    return { output: null, error: 'Tool result could not be serialised.' };
  }
}

function createTestLabAgent(role, { client, apiKey, model = configuredModels()[role], toolset, logger = console, maxToolRounds = (DEFAULT_ROLE_ROUND_BUDGETS[role] ?? 3) } = {}) {
  const definition = AGENT_DEFINITIONS[role];
  if (!definition) throw new TypeError('Unknown Test Lab agent: ' + role);
  if (!toolset || typeof toolset.execute !== 'function' || !Array.isArray(toolset.declarations)) throw new TypeError('A scoped ' + role + ' toolset is required.');
  const permitted = new Set(definition.tools);
  if (toolset.declarations.some(t => !permitted.has(t.name))) throw new Error(role + ' toolset exceeds its permission allowlist.');
  let genAI = client || null;

  async function invoke(task, context, { signal } = {}) {
    if (typeof task !== 'string' || !task.trim()) throw new TypeError('Agent task is required.');
    if (!genAI) genAI = makeClient(apiKey);
    const contents = [{ role: 'user', parts: [{ text: JSON.stringify({ task, context }) }] }];

    // In Gemini API, combining responseMimeType: 'application/json' / responseJsonSchema
    // with tools in the same request causes model looping and conflicts with function calling.
    // Instead, the schema requirement is clearly specified in systemInstruction,
    // and response.text is parsed and strictly validated by validateOutput(role, output).
    const systemInstruction = definition.instruction +
      '\nWhen you have gathered all needed evidence, return ONLY a single JSON object matching this schema (no markdown fences, no extra text): ' +
      JSON.stringify(definition.schema) + '.';

    const baseConfig = {
      systemInstruction,
      tools: [{ functionDeclarations: toolset.declarations }],
      temperature: 0.1,
      ...(signal ? { abortSignal: signal } : {})
    };

    const calledToolsHistory = [];

    for (let round = 0; round < maxToolRounds; round += 1) {
      if (signal?.aborted) throw signal.reason || new Error('Test Lab agent request aborted.');

      const roundStartedAt = Date.now();
      logger.info?.('[AI Test Lab] Gemini request started', { role, model, round });
      let response;
      let finishReason = null;
      try {
        response = await genAI.models.generateContent({ model, contents, config: baseConfig });
        finishReason = response?.candidates?.[0]?.finishReason ?? null;
        logger.info?.('[AI Test Lab] Gemini request completed', {
          role, model, round, finishReason, elapsedMs: Date.now() - roundStartedAt
        });
      } catch (error) {
        logger.error?.('[AI Test Lab] Gemini request failed', {
          role, model, round, elapsedMs: Date.now() - roundStartedAt,
          ...upstreamErrorDetails(error, apiKey || process.env.GEMINI_API_KEY)
        });
        throw error;
      }

      // SDK returns undefined (not []) when there are no function calls.
      const rawCalls = response?.functionCalls;
      let calls = Array.isArray(rawCalls) ? rawCalls : [];
      if (!calls.length && response?.candidates?.[0]?.content?.parts) {
        const partCalls = response.candidates[0].content.parts
          .filter(p => p && p.functionCall)
          .map(p => p.functionCall);
        if (partCalls.length) calls = partCalls;
      }

      if (!calls.length) {
        // No function calls -- expect terminal JSON in response.text.
        const rawText = response?.text;
        if (!rawText || !rawText.trim()) {
          throw new Error(definition.name + ' returned an empty response (finishReason: ' + finishReason + ').');
        }
        // Strip optional markdown fences the model may add despite instructions.
        const stripped = rawText.trim()
          .replace(/^```(?:json)?\s*/i, '')
          .replace(/\s*```\s*$/, '');
        let output;
        try {
          output = JSON.parse(stripped);
        } catch (_) {
          const firstBrace = rawText.indexOf('{');
          const lastBrace = rawText.lastIndexOf('}');
          if (firstBrace !== -1 && lastBrace > firstBrace) {
            try {
              output = JSON.parse(rawText.slice(firstBrace, lastBrace + 1));
            } catch (inner) {
              throw new Error(definition.name + ' returned invalid JSON (finishReason: ' + finishReason + '): ' + String(rawText).slice(0, 120));
            }
          } else {
            throw new Error(definition.name + ' returned invalid JSON (finishReason: ' + finishReason + '): ' + String(rawText).slice(0, 120));
          }
        }
        return validateOutput(role, output);
      }

      // Enforce tool-call limit.
      if (round >= maxToolRounds - 1) {
        const names = calls.map(c => c?.name).join(', ');
        throw new Error(definition.name + ' exceeded its tool-call limit (round ' + round + '; pending: ' + names + ').');
      }

      // Validate calls.
      for (const call of calls) {
        if (!call || typeof call.name !== 'string' || !call.name) {
          throw new Error(definition.name + ' returned a malformed tool call on round ' + round + '.');
        }
        if (!permitted.has(call.name)) {
          throw new Error(definition.name + ' attempted tool "' + call.name + '" which is outside its allowlist.');
        }
      }

      // Detect repeated or alternating tool calls (sign of a stuck loop).
      const thisRoundSignature = calls.map(c => `${c.name}:${JSON.stringify(c.args || {})}`).sort().join(';');
      const prevRound = calledToolsHistory[calledToolsHistory.length - 1];
      if (prevRound && prevRound === thisRoundSignature) {
        throw new Error(definition.name + ' called the same tool(s) [' + calls.map(c => c.name).join(', ') + '] twice in a row without making progress.');
      }
      const historyLen = calledToolsHistory.length;
      if (
        historyLen >= 3 &&
        calledToolsHistory[historyLen - 2] === thisRoundSignature &&
        calledToolsHistory[historyLen - 1] === calledToolsHistory[historyLen - 3]
      ) {
        throw new Error(definition.name + ' entered an alternating tool-call loop without making progress.');
      }
      calledToolsHistory.push(thisRoundSignature);

      // Append model content with function call(s) to history.
      const candidateContent = response.candidates?.[0]?.content;
      const modelContent = candidateContent
        ? { role: candidateContent.role || 'model', parts: candidateContent.parts || [] }
        : { role: 'model', parts: calls.map(c => ({ functionCall: c })) };
      contents.push(modelContent);

      // Execute tool calls and build function-response message.
      const responseParts = [];
      for (const call of calls) {
        logger.info?.('[AI Test Lab] Tool call dispatched', { role, round, tool: call.name });
        let result;
        try {
          result = await toolset.execute(call.name, call.args || {});
          logger.info?.('[AI Test Lab] Tool call completed', { role, round, tool: call.name, status: 'ok' });
        } catch (toolError) {
          if (toolError.code) throw toolError;
          logger.warn?.('[AI Test Lab] Tool call failed', { role, round, tool: call.name, error: toolError.message });
          result = { error: toolError.message || 'Tool execution failed.', available: false };
        }
        const normalizedResponse = normalizeToolResult(result);
        const part = { functionResponse: { name: call.name, response: normalizedResponse } };
        // Preserve call id if the SDK returned one.
        if (call.id) part.functionResponse.id = call.id;
        responseParts.push(part);
      }

      // Append tool results to conversation history.
      contents.push({ role: 'user', parts: responseParts });
    }

    throw new Error(definition.name + ' could not complete its task within ' + maxToolRounds + ' rounds.');
  }

  async function run(task, context, options) {
    const startedAt = new Date().toISOString();
    logger.info?.('[AI Test Lab] Agent started', { role, model });
    try {
      const output = await invoke(task, context, options);
      return { output, metadata: { agent: definition.name, role, model, task, status: 'success', startedAt, completedAt: new Date().toISOString() } };
    } catch (error) {
      logger.warn?.('[AI Test Lab] Agent failed', { role, model, status: error.status || null, code: error.code || null, name: error.name });
      error.agentMetadata = { agent: definition.name, role, model, task, status: 'error', startedAt, completedAt: new Date().toISOString() };
      throw error;
    }
  }
  return { role, name: definition.name, model, tools: [...definition.tools], run };
}

module.exports = { AGENT_DEFINITIONS, MODEL_DEFAULTS, MAX_TOOL_ROUNDS, DEFAULT_ROLE_ROUND_BUDGETS, configuredModels, createTestLabAgent, validateOutput, normalizeToolResult, upstreamErrorDetails };
