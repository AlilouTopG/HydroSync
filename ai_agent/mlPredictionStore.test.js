'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createMlPredictionStore,
  ML_PREDICTION_FRESHNESS_MS
} = require('./mlPredictionStore');

function prediction(state, timestamp) {
  return {
    state,
    state_confidence: 0.95,
    fault_type: 'bearing_wear',
    fault_confidence: 0.99,
    operating_condition: 'normal',
    oc_confidence: 0.8,
    timestamp
  };
}

test('keeps the current prediction pending and replaces it with the next valid response', async () => {
  const previousPrediction = prediction('fault', '2026-10-22T12:00:00.000Z');
  const nextPrediction = prediction('healthy', '2026-10-22T12:01:00.000Z');
  const store = createMlPredictionStore();
  await store.update(Promise.resolve(previousPrediction));

  let resolvePrediction;
  const pendingResponse = new Promise((resolve) => {
    resolvePrediction = resolve;
  });
  const update = store.update(pendingResponse);

  assert.strictEqual(store.get(), previousPrediction);

  resolvePrediction(nextPrediction);
  await update;

  assert.strictEqual(store.get(), nextPrediction);
  assert.equal(store.get().timestamp, nextPrediction.timestamp);
});

test('keeps the previous prediction unchanged when a response is invalid', async () => {
  const previousPrediction = prediction('fault', '2026-10-22T12:00:00.000Z');
  const store = createMlPredictionStore();
  await store.update(Promise.resolve(previousPrediction));

  await store.update(Promise.resolve({ state: 'fault' }));
  await store.update(Promise.resolve(null));
  await assert.rejects(
    store.update(Promise.reject(new Error('prediction request failed.'))),
    /prediction request failed/
  );

  assert.strictEqual(store.get(), previousPrediction);
  assert.equal(store.get().timestamp, '2026-10-22T12:00:00.000Z');
});

test('records Node receipt time and keeps model timestamp separate', async () => {
  const store = createMlPredictionStore();
  const modelResult = prediction('fault', '2026-10-22T12:00:00.000Z');
  await store.update(Promise.resolve(modelResult));
  const status = store.getStatus();

  assert.equal(status.status, 'fresh');
  assert.ok(status.receivedAt);
  assert.equal(status.modelTimestamp, modelResult.timestamp);
  assert.equal(store.get().timestamp, modelResult.timestamp);
  assert.equal(status.prediction.state, 'fault');
});

test('prediction transitions to stale while preserving the stored record', async () => {
  const store = createMlPredictionStore();
  const result = prediction('healthy', undefined);
  await store.update(Promise.resolve(result));
  const receivedAt = Date.parse(store.getRecord().receivedAt);
  const status = store.getStatus(receivedAt + ML_PREDICTION_FRESHNESS_MS + 1);

  assert.equal(status.status, 'stale');
  assert.equal(status.available, true);
  assert.equal(status.prediction.state, 'healthy');
  assert.equal(store.get().state, 'healthy');
  assert.equal(status.modelTimestamp, null);
});

test('no stored result is explicitly unavailable', () => {
  const status = createMlPredictionStore().getStatus();
  assert.equal(status.status, 'unavailable');
  assert.equal(status.available, false);
  assert.equal(status.prediction, null);
});
