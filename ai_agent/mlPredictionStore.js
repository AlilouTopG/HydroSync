'use strict';

const VALID_STATES = new Set(['fault', 'healthy', 'operating_condition']);
// Predictions are requested on a one-second telemetry loop; allow five missed
// cycles before treating the last result as stale.
const ML_PREDICTION_FRESHNESS_MS = 5000;

function isValidPrediction(prediction) {
  return Boolean(
    prediction &&
    typeof prediction === 'object' &&
    !Array.isArray(prediction) &&
    VALID_STATES.has(prediction.state) &&
    Number.isFinite(prediction.state_confidence) &&
    prediction.state_confidence >= 0 &&
    prediction.state_confidence <= 1 &&
    typeof prediction.fault_type === 'string' &&
    Number.isFinite(prediction.fault_confidence) &&
    prediction.fault_confidence >= 0 &&
    prediction.fault_confidence <= 1 &&
    typeof prediction.operating_condition === 'string' &&
    Number.isFinite(prediction.oc_confidence) &&
    prediction.oc_confidence >= 0 &&
    prediction.oc_confidence <= 1
  );
}

function createMlPredictionStore() {
  let storedResult = null;

  function getStatus(now = Date.now()) {
    if (!storedResult) {
      return {
        available: false,
        status: 'unavailable',
        prediction: null,
        receivedAt: null,
        modelTimestamp: null,
        ageMs: null,
        freshnessThresholdMs: ML_PREDICTION_FRESHNESS_MS
      };
    }

    const ageMs = Math.max(0, now - Date.parse(storedResult.receivedAt));
    return {
      available: true,
      status: ageMs <= ML_PREDICTION_FRESHNESS_MS ? 'fresh' : 'stale',
      prediction: storedResult.prediction,
      receivedAt: storedResult.receivedAt,
      modelTimestamp: storedResult.modelTimestamp,
      ageMs,
      freshnessThresholdMs: ML_PREDICTION_FRESHNESS_MS
    };
  }

  return {
    get() {
      return storedResult?.prediction ?? null;
    },

    getStatus,

    getRecord() {
      return storedResult;
    },

    clear() {
      storedResult = null;
    },

    async update(pendingPrediction) {
      const nextPrediction = await pendingPrediction;
      if (isValidPrediction(nextPrediction)) {
        const prediction = nextPrediction;
        storedResult = {
          prediction,
          receivedAt: new Date().toISOString(),
          modelTimestamp: typeof prediction.timestamp === 'string' && prediction.timestamp.trim()
            ? prediction.timestamp
            : null
        };
      }
      return this.get();
    }
  };
}

module.exports = {
  createMlPredictionStore,
  isValidPrediction,
  ML_PREDICTION_FRESHNESS_MS
};
