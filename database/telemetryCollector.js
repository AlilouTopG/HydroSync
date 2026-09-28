const pool = require('./db');

let experimentId = null;

async function startExperiment({
  name = `live_run_${new Date().toISOString()}`,
  description = 'HydroSync simulator telemetry collection run',
  source = 'simulator',
  simulatorVersion = 'current',
  metadata = {}
} = {}) {
  const result = await pool.query(
    `
    INSERT INTO experiments (
      name,
      description,
      source,
      simulator_version,
      metadata
    )
    VALUES ($1, $2, $3, $4, $5)
    RETURNING id
    `,
    [
      name,
      description,
      source,
      simulatorVersion,
      metadata
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
  const multiAxis = aiData.multi_axis || {};
  const multiAxisCombined = multiAxis.combined_features || {};

  const enrichedFeatures = {
    ...aiFeatures,
    multi_axis_version: multiAxis.version || state.waveformVersion || null,
    axes_available: multiAxis.axes_available || state.axesAvailable || null,
    vector_rms: multiAxisCombined.vector_rms ?? null,
    total_spectral_energy: multiAxisCombined.total_spectral_energy ?? null,
    rms_ratio_y_x: multiAxisCombined.rms_ratio_y_x ?? null,
    rms_ratio_z_x: multiAxisCombined.rms_ratio_z_x ?? null,
    corr_xy: multiAxisCombined.corr_xy ?? null,
    corr_xz: multiAxisCombined.corr_xz ?? null,
    corr_yz: multiAxisCombined.corr_yz ?? null
  };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const result = await client.query(
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
      RETURNING time, time::text AS time_str, id
      `,
      [
        experimentId,

        Number(state.motorTemp) || null,
        Number(state.tankVolumePct) || null,
        Number(state.pumpDuty) || 0,
        Number(state.flowRate) || 0,
        Boolean(state.pumpDuty > 0 || state.rawCommandDuty > 0),

        Number(asset.imbalanceLevel) || 0,
        Number(asset.bearingWearPct) || 0,
        Number(asset.cavitationIndex) || 0,

        Array.isArray(state.vibrationWaveform)
          ? state.vibrationWaveform
          : null,

        Number(state.samplingRateHz || asset.samplingRateHz) || null,
        Number(state.bufferSize || asset.bufferSize) || null,

        Number(aiFeatures.vibration_rms ?? asset.vibrationRms) || null,
        Number(aiFeatures.dominant_frequency_hz ?? asset.dominantFrequencyHz) || null,

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

        enrichedFeatures,

        {
          engine: aiData.engine || 'python-fastapi',
          collection: state.datasetCondition || null,
          safety: aiData.safety || null,
          collected_at: new Date().toISOString()
        }
      ]
    );

    const { time, time_str: timeStr, id: telemetryId } = result.rows[0];

    const waveformsDict = state.vibrationWaveforms || asset.vibrationWaveforms;
    if (waveformsDict && typeof waveformsDict === 'object') {
      const samplingRateHz = Number(state.samplingRateHz || asset.samplingRateHz || 1000);
      const bufferSize = Number(state.bufferSize || asset.bufferSize || 256);

      for (const axisKey of ['x', 'y', 'z']) {
        if (Array.isArray(waveformsDict[axisKey])) {
          const axisWaveform = waveformsDict[axisKey];
          const axisAi = multiAxis.axes?.[axisKey] || {};
          const axisFeat = axisAi.features || (axisKey === 'x' ? aiFeatures : {});
          const axisFft = axisAi.fft || (axisKey === 'x' ? aiData.fft : {});

          let vibRms = Number(axisFeat.vibration_rms) || null;
          let domFreq = Number(axisFeat.dominant_frequency_hz) || null;
          let oneX = Number(axisFeat.one_x_amplitude) || null;
          let twoX = Number(axisFeat.two_x_amplitude) || null;
          let twoXToOneX = Number(axisFeat.two_x_to_one_x_ratio) || null;
          let oneXToRms = Number(axisFeat.one_x_to_rms_ratio) || null;
          let specEnergy = Number(axisFeat.spectral_energy) || null;

          if (!vibRms && Array.isArray(axisWaveform) && axisWaveform.length > 0) {
            const n = axisWaveform.length;
            const mean = axisWaveform.reduce((sum, v) => sum + v, 0) / n;
            let sumSq = 0;
            for (let k = 0; k < n; k++) {
              const diff = axisWaveform[k] - mean;
              sumSq += diff * diff;
            }
            const rms = Math.sqrt(sumSq / n);
            vibRms = Number(rms.toFixed(4));
            domFreq = Number(aiFeatures.dominant_frequency_hz ?? asset.dominantFrequencyHz ?? 50.0);
            oneX = Number((rms * 0.8).toFixed(4));
            twoX = Number((rms * 0.3).toFixed(4));
            twoXToOneX = 0.375;
            oneXToRms = 0.8;
            specEnergy = Number((rms * rms * n).toFixed(4));
          }

          await client.query(
            `
            INSERT INTO telemetry_vibration_axes (
              time,
              telemetry_id,
              axis,
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
              fft_frequencies_hz,
              fft_magnitudes,
              features
            )
            VALUES (
              $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16
            )
            `,
            [
              timeStr,
              telemetryId,
              axisKey,
              axisWaveform,
              samplingRateHz,
              bufferSize,

              vibRms,
              domFreq,
              oneX,
              twoX,
              twoXToOneX,
              oneXToRms,
              specEnergy,

              Array.isArray(axisFft?.frequencies_hz) ? axisFft.frequencies_hz : null,
              Array.isArray(axisFft?.magnitudes) ? axisFft.magnitudes : null,

              { ...axisFeat, vibration_rms: vibRms, dominant_frequency_hz: domFreq }
            ]
          );
        }
      }
    }

    await client.query('COMMIT');
    return { time, id: telemetryId };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
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
