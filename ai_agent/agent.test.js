'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createHydroSyncAgent } = require('./agent');
const { createHydroSyncTools } = require('./tools');
const { createMlPredictionStore } = require('./mlPredictionStore');

function createMockClient(responses) {
  const queue = [...responses];
  const requests = [];

  return {
    requests,
    client: {
      models: {
        async generateContent(params) {
          requests.push(structuredClone(params));

          if (queue.length === 0) {
            throw new Error('Unexpected extra Gemini request in test.');
          }

          return queue.shift();
        }
      }
    }
  };
}

function functionCallResponse(name, args = {}) {
  return {
    functionCalls: [{ name, args }],
    candidates: [{
      content: {
        role: 'model',
        parts: [{ functionCall: { name, args } }]
      }
    }]
  };
}

test('agent executes a telemetry tool and returns the final answer', async () => {
  let snapshotReads = 0;

  const snapshot = {
    observedAt: '2026-10-20T12:00:00.000Z',
    telemetry: {
      pumpDuty: 60,
      flowRate: 12.5,
      motorTemp: 42,
      safety: { systemStatus: 'NORMAL', tripped: false, alarms: [] }
    },
    diagnostics: null,
    mlPrediction: null
  };

  const toolset = createHydroSyncTools({
    getSnapshot: async () => {
      snapshotReads += 1;
      return snapshot;
    }
  });

  const mock = createMockClient([
    functionCallResponse('get_current_telemetry'),
    {
      text: 'Pump duty is currently 60%.',
      candidates: [{
        content: {
          role: 'model',
          parts: [{ text: 'Pump duty is currently 60%.' }]
        }
      }]
    }
  ]);

  const agent = createHydroSyncAgent({
    toolset,
    client: mock.client,
    model: 'mock-model'
  });

  const answer = await agent.answer({
    message: 'What is the current pump duty?',
    safety: 'NORMAL',
    activeZone: 'A1'
  });

  assert.equal(answer, 'Pump duty is currently 60%.');
  assert.equal(mock.requests.length, 2);
  assert.equal(snapshotReads, 1);

  const secondRequestContents = mock.requests[1].contents;
  const functionResponsePart = secondRequestContents
    .flatMap(item => item.parts || [])
    .find(part => part.functionResponse);

  assert.ok(functionResponsePart);
  assert.equal(functionResponsePart.functionResponse.name, 'get_current_telemetry');
  assert.equal(
    functionResponsePart.functionResponse.response.telemetry.pumpDuty,
    60
  );

  console.log('Verified: telemetry tool result was returned to the model.');
});

test('agent reports unavailable ML predictions without inventing one', async () => {
  const toolset = createHydroSyncTools({
    getSnapshot: async () => ({
      telemetry: null,
      diagnostics: null,
      mlPrediction: null
    })
  });

  const mock = createMockClient([
    functionCallResponse('get_latest_ml_prediction'),
    {
      text: 'There is no valid ML prediction available at the moment.',
      candidates: [{
        content: {
          role: 'model',
          parts: [{
            text: 'There is no valid ML prediction available at the moment.'
          }]
        }
      }]
    }
  ]);

  const agent = createHydroSyncAgent({
    toolset,
    client: mock.client,
    model: 'mock-model'
  });

  const answer = await agent.answer({
    message: 'What is the latest ML prediction?'
  });

  assert.match(answer, /no valid ML prediction/i);

  const functionResponsePart = mock.requests[1].contents
    .flatMap(item => item.parts || [])
    .find(part => part.functionResponse);

  assert.ok(functionResponsePart);
  assert.equal(functionResponsePart.functionResponse.response.available, false);
  assert.equal(functionResponsePart.functionResponse.response.prediction, null);

  console.log('Verified: missing predictions are reported as unavailable.');
});

test('agent can answer directly without invoking a tool', async () => {
  let snapshotReads = 0;

  const toolset = createHydroSyncTools({
    getSnapshot: async () => {
      snapshotReads += 1;
      return {};
    }
  });

  const mock = createMockClient([{
    text: 'HydroSync is a pump monitoring system.',
    candidates: [{
      content: {
        role: 'model',
        parts: [{ text: 'HydroSync is a pump monitoring system.' }]
      }
    }]
  }]);

  const agent = createHydroSyncAgent({
    toolset,
    client: mock.client,
    model: 'mock-model'
  });

  const answer = await agent.answer({ message: 'What is HydroSync?' });

  assert.equal(answer, 'HydroSync is a pump monitoring system.');
  assert.equal(mock.requests.length, 1);
  assert.equal(snapshotReads, 0);

  console.log('Verified: ordinary questions do not require a tool call.');
});

test('agent passes abort signal to Gemini and does not continue after cancellation', async () => {
  let snapshotReads = 0;
  let receivedSignal;
  const toolset = createHydroSyncTools({
    getSnapshot: async () => {
      snapshotReads += 1;
      return {};
    }
  });
  const logs = [];
  const agent = createHydroSyncAgent({
    toolset,
    client: {
      models: {
        generateContent({ config }) {
          receivedSignal = config.abortSignal;
          return new Promise((resolve, reject) => {
            config.abortSignal.addEventListener('abort', () => {
              reject(config.abortSignal.reason || new Error('Aborted.'));
            }, { once: true });
          });
        }
      }
    },
    logger: {
      info(_message, fields) {
        logs.push(fields);
      }
    }
  });

  const controller = new AbortController();
  const answerPromise = agent.answer({
    message: 'Check current telemetry.',
    signal: controller.signal
  });
  controller.abort(new Error('Gemini request timed out'));

  await assert.rejects(answerPromise, /Gemini request timed out/);
  assert.equal(receivedSignal, controller.signal);
  assert.equal(snapshotReads, 0);
  assert.deepEqual(
    logs.map(entry => entry.event),
    ['agent.start', 'gemini.request.start', 'gemini.request.complete', 'agent.complete']
  );
  assert.equal(logs[2].status, 'error');
  assert.equal(logs[3].status, 'error');
});

test('agent logs only structured identity and numerical fields for diagnostics tool output', async () => {
  const features = {
    vibration_rms: 0.52,
    dominant_amplitude: 0.6902,
    bearing_band_rms: 0.027
  };
  const toolset = createHydroSyncTools({
    getSnapshot: async () => ({
      diagnostics: {
        sampleId: 'waveform-abc123',
        observedAt: '2026-10-22T18:30:00.000Z',
        features,
        fft: { magnitudes: [0, 0.69], waveform: [1, 2] },
        fftAvailable: true,
        multiAxisAvailable: true
      }
    })
  });
  const mock = createMockClient([
    functionCallResponse('get_ai_diagnostics'),
    { text: 'Diagnostics received.' }
  ]);
  const logs = [];
  const agent = createHydroSyncAgent({
    toolset,
    client: mock.client,
    logger: {
      info(message, fields) {
        logs.push({ message, fields });
      }
    }
  });

  await agent.answer({ message: 'Read vibration diagnostics.' });

  const diagnosticLog = logs.find(entry => entry.fields?.event === 'tool.result');
  assert.ok(diagnosticLog);
  assert.deepEqual(diagnosticLog.fields, {
    event: 'tool.result',
    tool: 'get_ai_diagnostics',
    sampleId: 'waveform-abc123',
    observedAt: '2026-10-22T18:30:00.000Z',
    features,
    fftAvailable: true,
    multiAxisAvailable: true
  });

  const functionResponsePart = mock.requests[1].contents
    .flatMap(item => item.parts || [])
    .find(part => part.functionResponse);
  assert.deepEqual(
    functionResponsePart.functionResponse.response.diagnostics.features,
    features
  );
  assert.equal(
    Object.hasOwn(diagnosticLog.fields, 'waveform'),
    false
  );
});

test('diagnostics tool reads metadata and features from the same vibration snapshot', async () => {
  const vibrationSnapshot = {
    sampleId: 'source-sample-42',
    observedAt: '2026-10-22T19:45:00.000Z',
    features: { vibration_rms: 0.52 }
  };
  const toolset = createHydroSyncTools({
    getSnapshot: async () => ({
      vibrationSnapshot,
      diagnostics: {
        sampleId: null,
        observedAt: null,
        features: null
      }
    })
  });

  const result = await toolset.execute('get_ai_diagnostics');

  assert.equal(result.sampleId, vibrationSnapshot.sampleId);
  assert.equal(result.observedAt, vibrationSnapshot.observedAt);
  assert.deepEqual(result.diagnostics.features, vibrationSnapshot.features);
});

test('dashboard-facing store and agent tool expose identical fresh prediction data', async () => {
  const store = createMlPredictionStore();
  const modelPrediction = {
    state: 'fault', state_confidence: 0.91,
    fault_type: 'bearing_wear', fault_confidence: 0.82,
    operating_condition: 'normal', oc_confidence: 0.75,
    timestamp: '2026-10-23T09:00:00.000Z', metadata: { model: 'v2' }
  };
  await store.update(Promise.resolve(modelPrediction));
  const dashboardPrediction = store.getStatus();
  const tools = createHydroSyncTools({
    getSnapshot: async () => ({
      mlPrediction: dashboardPrediction.prediction,
      mlPredictionStatus: dashboardPrediction
    })
  });

  assert.deepEqual(await tools.execute('get_latest_ml_prediction'), dashboardPrediction);
});

test('agent passes stale prediction metadata and communicates it as stale', async () => {
  const stored = {
    available: true, status: 'stale',
    prediction: {
      state: 'fault', state_confidence: 0.9,
      fault_type: 'bearing_wear', fault_confidence: 0.8,
      operating_condition: 'normal', oc_confidence: 0.7
    },
    receivedAt: '2026-10-20T12:00:00.000Z', modelTimestamp: null,
    ageMs: 6000, freshnessThresholdMs: 5000
  };
  const toolset = createHydroSyncTools({ getSnapshot: async () => ({
    mlPrediction: stored.prediction,
    mlPredictionStatus: stored
  }) });
  const mock = createMockClient([
    functionCallResponse('get_latest_ml_prediction'),
    { text: 'The last prediction is stale (6 seconds old): fault, with 90% state confidence. It should not be treated as current.' }
  ]);
  const agent = createHydroSyncAgent({ toolset, client: mock.client, model: 'mock-model' });
  const answer = await agent.answer({ message: 'What is the latest ML prediction?' });

  assert.match(answer, /stale/i);
  assert.match(answer, /not be treated as current/i);
  const toolResponse = mock.requests[1].contents.flatMap(item => item.parts || [])
    .find(part => part.functionResponse).functionResponse.response;
  assert.equal(toolResponse.status, 'stale');
  assert.equal(toolResponse.prediction.state, 'fault');
});

test('agent communicates unavailable ML result without deriving a prediction from telemetry', async () => {
  const toolset = createHydroSyncTools({
    getSnapshot: async () => ({
      telemetry: { motorTemp: 99, pumpDuty: 55 },
      mlPrediction: null,
      mlPredictionStatus: { available: false, status: 'unavailable', prediction: null }
    })
  });
  const mock = createMockClient([
    functionCallResponse('get_latest_ml_prediction'),
    { text: 'No ML prediction is available, so I cannot report a predicted state or confidence.' }
  ]);
  const agent = createHydroSyncAgent({ toolset, client: mock.client, model: 'mock-model' });
  const answer = await agent.answer({ message: 'What does ML predict?' });

  assert.match(answer, /no ML prediction is available/i);
  assert.doesNotMatch(answer, /healthy|fault|confidence: [0-9]/i);
  const toolResponse = mock.requests[1].contents.flatMap(item => item.parts || [])
    .find(part => part.functionResponse).functionResponse.response;
  assert.equal(toolResponse.status, 'unavailable');
  assert.equal(toolResponse.prediction, null);
});

test('agent sends recent user and assistant turns to Gemini using SDK content messages', async () => {
  const toolset = createHydroSyncTools({ getSnapshot: async () => ({}) });
  const mock = createMockClient([{ text: 'The earlier result was 60% duty.' }]);
  const agent = createHydroSyncAgent({ toolset, client: mock.client });

  await agent.answer({
    message: 'Why?',
    safety: 'NORMAL',
    activeZone: 'A1',
    history: [{ user: 'What was the pump duty?', assistant: 'The current duty was 60%.' }]
  });

  const contents = mock.requests[0].contents;
  assert.deepEqual(contents.slice(0, 2), [
    { role: 'user', parts: [{ text: 'What was the pump duty?' }] },
    { role: 'model', parts: [{ text: 'The current duty was 60%.' }] }
  ]);
  assert.equal(contents.at(-1).role, 'user');
  assert.match(contents.at(-1).parts[0].text, /Never use remembered telemetry/i);
  assert.match(contents.at(-1).parts[0].text, /Why\?/);
});

test('current-state question after history still reads live telemetry', async () => {
  let reads = 0;
  const toolset = createHydroSyncTools({ getSnapshot: async () => {
    reads += 1;
    return { telemetry: { pumpDuty: 72 }, observedAt: '2026-10-23T12:00:00Z' };
  } });
  const mock = createMockClient([
    functionCallResponse('get_current_telemetry'),
    { text: 'Current pump duty is 72%.' }
  ]);
  const agent = createHydroSyncAgent({ toolset, client: mock.client });
  await agent.answer({
    message: 'Is it still happening?',
    history: [{ user: 'What was the pump duty?', assistant: 'It was 60%.' }]
  });

  assert.equal(reads, 1);
  const contents = mock.requests[0].contents;
  assert.equal(contents[0].role, 'user');
  assert.equal(contents[1].role, 'model');
  const toolResult = mock.requests[1].contents.flatMap(item => item.parts || [])
    .find(part => part.functionResponse).functionResponse.response;
  assert.equal(toolResult.telemetry.pumpDuty, 72);
});
