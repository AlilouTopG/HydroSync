const pool = require('./db');

let experimentId = null;

async function startExperiment() {
  const result = await pool.query(
    `
    INSERT INTO experiments (
      name,
      description,
      source,
      simulator_version
    )
    VALUES ($1, $2, $3, $4)
    RETURNING id
    `,
    [
      `live_run_${new Date().toISOString()}`,
      'HydroSync simulator telemetry collection run',
      'simulator',
      'current'
    ]
  );

  experimentId = result.rows[0].id;

  console.log(`[DB] Experiment started: ${experimentId}`);

  return experimentId;
}

async function recordTelemetry(state, aiData = {}) {
  if (!experimentId) {
    throw new Error('Telemetry collector has no active experiment');
  }

  const asset = state.assetHealth || {};
  const aiFeatures = aiData.features || {};

  await pool.query(
    `
    INSERT INTO telemetry (
      time,
      experiment_id,

      motor_temp_c,
      tank_volume_pct,
      pump_duty_pct,
      flow_rate,
      is_running,

      imbalance_level_pct,
      bearing_wear_pct,
      cavitation_index,

      vibration_waveform,
      sampling_rate_hz,
      buffer_size,

      vibration_rms,
      dominant_frequency_hz,
      one_x_amplitude,
      two_x_amplitude,
      two_x_to_one_x_ratio,
      one_x_to_rms_ratio,
      spectral_energy,
      crest_factor,
      kurtosis,

      anomaly_score,
      anomaly_detected,
      predicted_fault,
      fault_confidence,

      cavitation_probability,
      bearing_probability,
      imbalance_probability,

      fft_frequencies_hz,
      fft_magnitudes,

      features,
      model_metadata
    )
    VALUES (
      NOW(),
      $1,

      $2, $3, $4, $5, $6,

      $7, $8, $9,

      $10, $11, $12,

      $13, $14, $15, $16, $17, $18, $19, $20, $21,

      $22, $23, $24, $25,

      $26, $27, $28,

      $29, $30,

      $31,
      $32
    )
    `,
    [
      experimentId,

      Number(state.motorTemp) || null,
      Number(state.tankVolumePct) || null,
      Number(state.pumpDuty) || 0,
      Number(state.flowRate) || 0,
      Boolean(state.isRunning),

      Number(asset.imbalanceLevel) || 0,
      Number(asset.bearingWearPct) || 0,
      Number(asset.cavitationIndex) || 0,

      Array.isArray(state.vibrationWaveform)
        ? state.vibrationWaveform
        : null,

      Number(state.samplingRateHz || asset.samplingRateHz) || null,
      Number(state.bufferSize || asset.bufferSize) || null,

      Number(aiFeatures.vibration_rms) || null,
      Number(aiFeatures.dominant_frequency_hz) || null,

      Number(aiFeatures.one_x_amplitude) || null,

      
      Number(aiFeatures.two_x_amplitude) || null,
      Number(aiFeatures.two_x_to_one_x_ratio) || null,
      Number(aiFeatures.one_x_to_rms_ratio) || null,
      Number(aiFeatures.spectral_energy) || null,
      Number(aiFeatures.crest_factor) || null,
      Number(aiFeatures.kurtosis) || null,

      Number(aiFeatures.anomaly_score) || null,
      typeof aiFeatures.anomaly_detected === 'boolean'
        ? aiFeatures.anomaly_detected
        : null,
      aiFeatures.predicted_fault || null,
      Number(aiFeatures.fault_confidence) || null,

      Number(aiFeatures.cavitation_probability) || null,
      Number(aiFeatures.bearing_probability) || null,
      Number(aiFeatures.imbalance_probability) || null,

      Array.isArray(aiData.fft?.frequencies_hz)
        ? aiData.fft.frequencies_hz
        : null,

      Array.isArray(aiData.fft?.magnitudes)
        ? aiData.fft.magnitudes
        : null,

      aiFeatures,

      {
        engine: aiData.engine || 'python-fastapi',
        collected_at: new Date().toISOString()
      }
    ]
  );
}

async function endExperiment() {
  if (!experimentId) return;

  await pool.query(
    `
    UPDATE experiments
    SET ended_at = NOW()
    WHERE id = $1
    `,
    [experimentId]
  );

  console.log(`[DB] Experiment ended: ${experimentId}`);
  experimentId = null;
}

function getExperimentId() {
  return experimentId;
}

module.exports = {
  startExperiment,
  recordTelemetry,
  endExperiment,
  getExperimentId
};