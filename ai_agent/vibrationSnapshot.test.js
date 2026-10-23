'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createHydroSyncTools } = require('./tools');
const {
  addCaptureMetadata,
  createDiagnosticsResponse,
  createDiagnosticsSnapshot,
  createVibrationSnapshotStore
} = require('./vibrationSnapshot');

test('capture metadata is unique and records a real UTC capture timestamp', () => {
  const first = addCaptureMetadata({ vibrationWaveform: [0, 1] });
  const second = addCaptureMetadata({ vibrationWaveform: [1, 0] });

  assert.ok(first.sampleId);
  assert.ok(second.sampleId);
  assert.notEqual(first.sampleId, second.sampleId);
  assert.equal(new Date(first.observedAt).toISOString(), first.observedAt);
  assert.equal(new Date(second.observedAt).toISOString(), second.observedAt);
});

test('agent and diagnostics HTTP response expose one matching vibration sample', async () => {
  const sampleId = 'waveform-abc123';
  const observedAt = '2026-10-22T18:30:00.000Z';
  const features = { vibration_rms: 0.52, dominant_frequency_hz: 50 };
  const fft = { frequencies_hz: [0, 50], magnitudes: [0, 0.69] };
  const multiAxis = { axes_available: ['x', 'y', 'z'] };
  const store = createVibrationSnapshotStore();

  store.update({
    sampleId,
    observedAt,
    waveform: [0, 1],
    features,
    fft,
    peaks: [],
    multi_axis: multiAxis
  });

  const snapshot = store.get();
  const agentTools = createHydroSyncTools({
    getSnapshot: async () => ({
      diagnostics: createDiagnosticsSnapshot(snapshot, {
        status: 'ONLINE',
        engine: 'Python-FastAPI'
      })
    })
  });
  const agentResult = await agentTools.execute('get_ai_diagnostics');
  const httpResult = createDiagnosticsResponse(snapshot, {
    status: 'ONLINE',
    engine: 'Python-FastAPI',
    includeVibration: true
  });

  assert.equal(agentResult.sampleId, sampleId);
  assert.equal(agentResult.observedAt, observedAt);
  assert.equal(httpResult.sampleId, sampleId);
  assert.equal(httpResult.observedAt, observedAt);
  assert.deepEqual(agentResult.diagnostics.features, httpResult.features);
  assert.deepEqual(agentResult.diagnostics.fft, httpResult.fft);
  assert.deepEqual(agentResult.diagnostics.multi_axis, httpResult.vibration.multi_axis);
  assert.equal(agentResult.diagnostics.fftAvailable, true);
  assert.equal(agentResult.diagnostics.multiAxisAvailable, true);
});

test('missing capture metadata stays null instead of being fabricated or inherited', async () => {
  const store = createVibrationSnapshotStore();
  store.update({
    sampleId: 'first-sample',
    observedAt: '2026-10-22T18:30:00.000Z',
    features: { vibration_rms: 0.5 }
  });
  store.update({
    features: { vibration_rms: 0.6 },
    fft: null,
    multi_axis: null
  });

  const snapshot = store.get();
  const agentTools = createHydroSyncTools({
    getSnapshot: async () => ({
      diagnostics: createDiagnosticsSnapshot(snapshot, {
        status: 'FALLBACK',
        engine: 'Node-ISO10816-Baseline'
      })
    })
  });
  const agentResult = await agentTools.execute('get_ai_diagnostics');
  const httpResult = createDiagnosticsResponse(snapshot, {
    status: 'FALLBACK',
    engine: 'Node-ISO10816-Baseline'
  });

  assert.equal(agentResult.sampleId, null);
  assert.equal(agentResult.observedAt, null);
  assert.equal(httpResult.sampleId, null);
  assert.equal(httpResult.observedAt, null);
  assert.deepEqual(agentResult.diagnostics.features, httpResult.features);
  assert.equal(agentResult.diagnostics.fftAvailable, false);
  assert.equal(agentResult.diagnostics.multiAxisAvailable, false);
});
