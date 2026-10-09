require('dotenv').config();

const fs = require('fs');
const path = require('path');
const pool = require('./database/db');

pool.options.statement_timeout = 120000;
pool.options.query_timeout = 120000;

const OUTPUT_PATH = path.join(__dirname, 'multiaxis_hydrosync_dataset.csv');
const COLUMNS = [
  'time_utc',
  'elapsed_ms',
  'telemetry_id',
  'experiment_id',
  'axis',
  'is_multi_axis',
  'axes_available',
  'sampling_rate_hz',
  'vibration_rms',
  'dominant_frequency_hz',
  'one_x_amplitude',
  'two_x_amplitude',
  'two_x_to_one_x_ratio',
  'spectral_energy',
  'sim_imbalance_level_pct',
  'sim_bearing_wear_pct',
  'sim_cavitation_index',
  'motor_temp_c',
  'pwm_actual',
  'fault_type',
  'operating_condition',
  'severity_injected',
  'is_baseline',
  'condition_block_id',
  'pwm_target',
  'stable',
  'sample_id',
  'iso_class',
  'mounting',
  'vibration_rms_unit',
  'waveform'
];

function csvValue(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

async function main() {
  const result = await pool.query(`
    SELECT
      t.time,
      ROUND(EXTRACT(EPOCH FROM (
        t.time - MIN(t.time) OVER (PARTITION BY collection.collection->>'condition_block_id')
      )) * 1000)::bigint AS elapsed_ms,
      t.id AS telemetry_id,
      t.experiment_id,
      t.sampling_rate_hz,
      t.vibration_rms,
      t.dominant_frequency_hz,
      t.one_x_amplitude,
      t.two_x_amplitude,
      t.two_x_to_one_x_ratio,
      t.spectral_energy,
      t.imbalance_level_pct AS sim_imbalance_level_pct,
      t.bearing_wear_pct AS sim_bearing_wear_pct,
      t.cavitation_index AS sim_cavitation_index,
      t.motor_temp_c,
      t.pump_duty_pct AS pwm_actual,
      collection.collection->>'fault_type' AS fault_type,
      collection.collection->>'operating_condition' AS operating_condition,
      collection.collection->>'severity_injected' AS severity_injected,
      collection.collection->>'is_baseline' AS is_baseline,
      collection.collection->>'condition_block_id' AS condition_block_id,
      collection.collection->>'pwm_target' AS pwm_target,
      collection.collection->>'sample_id' AS sample_id,
      array_to_string(t.vibration_waveform, ';') AS waveform
    FROM telemetry AS t
    CROSS JOIN LATERAL (
      SELECT t.model_metadata->'collection' AS collection
    ) AS collection
    WHERE t.collection_source = 'auto-collect'
      AND t.pump_duty_pct >= 40
    ORDER BY t.time, t.id
  `);

  const output = fs.createWriteStream(OUTPUT_PATH, { encoding: 'utf8' });
  try {
    output.write(`${COLUMNS.join(',')}\r\n`);
    for (const row of result.rows) {
      const values = [
        row.time instanceof Date ? row.time.toISOString() : new Date(row.time).toISOString(),
        row.elapsed_ms,
        row.telemetry_id,
        row.experiment_id,
        'x',
        false,
        '["x","y","z"]',
        row.sampling_rate_hz,
        row.vibration_rms,
        row.dominant_frequency_hz,
        row.one_x_amplitude,
        row.two_x_amplitude,
        row.two_x_to_one_x_ratio,
        row.spectral_energy,
        row.sim_imbalance_level_pct,
        row.sim_bearing_wear_pct,
        row.sim_cavitation_index,
        row.motor_temp_c,
        row.pwm_actual,
        row.fault_type,
        row.operating_condition,
        row.severity_injected,
        row.is_baseline,
        row.condition_block_id,
        row.pwm_target,
        '',
        row.sample_id,
        'II',
        'rigid',
        'mm/s',
        row.waveform
      ];
      output.write(`${values.map(csvValue).join(',')}\r\n`);
    }
    await new Promise((resolve, reject) => {
      output.on('error', reject);
      output.end(resolve);
    });
  } catch (error) {
    output.destroy();
    throw error;
  }

  console.log(`Exported ${result.rowCount} rows to ${OUTPUT_PATH}`);
}

main()
  .catch(error => {
    console.error(`[EXPORT] Failed to write multiaxis dataset: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
