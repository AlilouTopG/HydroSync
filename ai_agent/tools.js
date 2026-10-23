'use strict';

const { isValidPrediction } = require('./mlPredictionStore');

function validateToolResult(name, result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return { available: false, error: 'The tool returned an invalid result.' };
  }

  if (name !== 'get_latest_ml_prediction') return result;

  if (result.status === 'unavailable' || result.available === false) {
    return {
      available: false,
      status: 'unavailable',
      prediction: null,
      receivedAt: null,
      modelTimestamp: null,
      reason: result.reason || 'No valid ML prediction is currently stored.'
    };
  }

  if (!isValidPrediction(result.prediction)) {
    return {
      available: false,
      status: 'unavailable',
      prediction: null,
      receivedAt: null,
      modelTimestamp: null,
      reason: 'The stored ML prediction is missing required fields or contains invalid values.'
    };
  }

  if (!['fresh', 'stale'].includes(result.status)) {
    return {
      available: false,
      status: 'unavailable',
      prediction: null,
      receivedAt: null,
      modelTimestamp: null,
      reason: 'The stored ML prediction has invalid freshness metadata.'
    };
  }

  if (
    !Number.isFinite(result.ageMs) || result.ageMs < 0 ||
    !Number.isFinite(result.freshnessThresholdMs) || result.freshnessThresholdMs <= 0 ||
    typeof result.receivedAt !== 'string'
  ) {
    return {
      available: false,
      status: 'unavailable',
      prediction: null,
      receivedAt: null,
      modelTimestamp: null,
      reason: 'The stored ML prediction has missing or invalid freshness metadata.'
    };
  }

  return result;
}

const TOOL_DECLARATIONS = [
  {
    name: 'get_current_telemetry',
    description:
      'Read current HydroSync pump and system telemetry. ' +
      'This tool is read-only and cannot control equipment.',
    parametersJsonSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: 'get_ai_diagnostics',
    description:
      'Read the latest available HydroSync AI diagnostics, ' +
      'vibration features, and AI engine status. ' +
      'Report unavailable data honestly.',
    parametersJsonSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: 'get_latest_ml_prediction',
    description:
      'Read the latest stored HydroSync ML prediction. ' +
      'Never infer a prediction if none is available.',
    parametersJsonSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false
    }
  }
];

function createHydroSyncTools({ getSnapshot } = {}) {
  if (typeof getSnapshot !== 'function') {
    throw new TypeError('getSnapshot must be a function.');
  }

  const handlers = {
    get_current_telemetry(snapshot) {
      if (snapshot.telemetry == null) {
        return {
          available: false,
          reason: 'Current telemetry is unavailable.'
        };
      }

      return {
        available: true,
        observedAt: snapshot.observedAt || null,
        telemetry: snapshot.telemetry
      };
    },

    get_ai_diagnostics(snapshot) {
      if (snapshot.diagnostics == null) {
        return {
          available: false,
          reason: 'AI diagnostics are unavailable.'
        };
      }

      const sourceSnapshot = snapshot.vibrationSnapshot || snapshot.diagnostics;
      const diagnostics = {
        ...snapshot.diagnostics,
        sampleId: sourceSnapshot.sampleId ?? null,
        observedAt: sourceSnapshot.observedAt ?? null,
        features: sourceSnapshot.features ?? null
      };
      return {
        available: true,
        sampleId: sourceSnapshot.sampleId ?? null,
        observedAt: sourceSnapshot.observedAt ?? null,
        diagnostics
      };
    },

    get_latest_ml_prediction(snapshot) {
      const predictionStatus = snapshot.mlPredictionStatus || null;
      if (!predictionStatus || predictionStatus.status === 'unavailable' || predictionStatus.prediction == null) {
        return {
          available: false,
          status: 'unavailable',
          prediction: null,
          receivedAt: null,
          modelTimestamp: null,
          reason:
            'No valid ML prediction is currently stored. ' +
            'The prediction may be pending, suppressed, or unavailable.'
        };
      }

      return {
        available: true,
        status: predictionStatus?.status || 'unavailable',
          prediction: predictionStatus.prediction,
        receivedAt: predictionStatus.receivedAt ?? null,
        modelTimestamp: predictionStatus.modelTimestamp ?? null,
        ageMs: predictionStatus.ageMs ?? null,
        freshnessThresholdMs: predictionStatus.freshnessThresholdMs ?? null
      };
    }
  };

  return {
    declarations: TOOL_DECLARATIONS,

    async execute(name, args = {}) {
      if (!Object.prototype.hasOwnProperty.call(handlers, name)) {
        throw new Error(`Tool is not allowlisted: ${name}`);
      }

      if (
        args === null ||
        typeof args !== 'object' ||
        Array.isArray(args) ||
        Object.keys(args).length !== 0
      ) {
        throw new TypeError(`Invalid arguments for tool: ${name}`);
      }

      // Obtain a fresh snapshot on every tool execution.
      const snapshot = await getSnapshot();

      if (!snapshot || typeof snapshot !== 'object') {
        throw new Error('HydroSync system snapshot is unavailable.');
      }

      return handlers[name](snapshot);
    }
  };
}

module.exports = {
  TOOL_DECLARATIONS,
  createHydroSyncTools,
  validateToolResult
};
