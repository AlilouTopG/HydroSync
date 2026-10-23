'use strict';

const crypto = require('node:crypto');

function addCaptureMetadata(payload) {
  return {
    ...payload,
    sampleId: crypto.randomUUID(),
    observedAt: new Date().toISOString()
  };
}

function hasUsableFft(fft) {
  return Boolean(
    fft &&
    Array.isArray(fft.magnitudes) &&
    fft.magnitudes.length > 0 &&
    Array.isArray(fft.frequencies_hz)
  );
}

function createVibrationSnapshotStore() {
  let latest = Object.freeze({
    sampleId: null,
    observedAt: null,
    waveform: null,
    features: null,
    fft: null,
    peaks: null,
    multi_axis: null,
    samples: null,
    sampling_rate_hz: null
  });

  return {
    update(data) {
      if (!data || typeof data !== 'object' || !Object.hasOwn(data, 'features')) {
        return latest;
      }

      latest = Object.freeze({
        sampleId: typeof data.sampleId === 'string' && data.sampleId.trim()
          ? data.sampleId
          : null,
        observedAt: typeof data.observedAt === 'string' && data.observedAt.trim()
          ? data.observedAt
          : null,
        waveform: Array.isArray(data.waveform) ? data.waveform : null,
        features: data.features && typeof data.features === 'object'
          ? data.features
          : null,
        fft: hasUsableFft(data.fft) ? data.fft : null,
        peaks: Array.isArray(data.peaks) ? data.peaks : null,
        multi_axis: data.multi_axis && typeof data.multi_axis === 'object'
          ? data.multi_axis
          : null,
        samples: Number.isInteger(data.samples) ? data.samples : null,
        sampling_rate_hz: Number.isFinite(data.sampling_rate_hz)
          ? data.sampling_rate_hz
          : null
      });
      return latest;
    },

    get() {
      return latest;
    }
  };
}

function createDiagnosticsSnapshot(snapshot, { status, engine, message } = {}) {
  const result = {
    status,
    engine,
    sampleId: snapshot?.sampleId ?? null,
    observedAt: snapshot?.observedAt ?? null,
    features: snapshot?.features ?? null,
    fft: snapshot?.fft ?? null,
    multi_axis: snapshot?.multi_axis ?? null,
    fftAvailable: hasUsableFft(snapshot?.fft),
    multiAxisAvailable: Boolean(snapshot?.multi_axis)
  };

  if (message) result.message = message;
  return result;
}

function createDiagnosticsResponse(
  snapshot,
  { status, engine, diagnosticsMessage, message, includeVibration = false } = {}
) {
  const diagnostics = createDiagnosticsSnapshot(snapshot, {
    status,
    engine,
    message: diagnosticsMessage
  });
  const response = {
    status,
    engine,
    diagnostics,
    sampleId: snapshot?.sampleId ?? null,
    observedAt: snapshot?.observedAt ?? null,
    fft: snapshot?.fft ?? null,
    features: snapshot?.features ?? null
  };

  if (includeVibration) response.vibration = snapshot;
  if (message) response.msg = message;
  return response;
}

module.exports = {
  addCaptureMetadata,
  createDiagnosticsResponse,
  createDiagnosticsSnapshot,
  createVibrationSnapshotStore
};
