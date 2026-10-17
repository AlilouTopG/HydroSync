const crypto = require('crypto');
const { once } = require('events');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { analyzeWaveform } = require('./database/vibrationAnalysis');

const SOURCES = [
  {
    file: 'multiaxis_hydrosync_dataset.csv',
    path: 'C:\\Users\\pc\\Downloads\\multiaxis_hydrosync_dataset.csv',
    expectedRows: 712553
  },
  {
    file: 'healthy_diverse_export.csv',
    path: path.join(__dirname, 'healthy_diverse_export.csv'),
    expectedRows: 75000
  }
];

const OUTPUT_COLUMNS = [
  'source_file',
  'source_experiment_key',
  'source_record_key',
  'time_utc',
  'experiment_id',
  'condition_block_id',
  'sample_id',
  'telemetry_id',
  'collection_source',
  'axis',
  'is_multi_axis',
  'axes_available',
  'sampling_rate_hz',
  'waveform_sample_count',
  'waveform_sha256',
  'fault_type',
  'operating_condition',
  'severity_injected',
  'is_baseline',
  'task1_label',
  'vibration_rms',
  'dominant_frequency_hz',
  'one_x_amplitude',
  'two_x_amplitude',
  'two_x_to_one_x_ratio',
  'spectral_energy',
  'motor_temp_c',
  'pwm_actual',
  'pwm_target'
];

const VIBRATION_FEATURES = [
  'vibration_rms',
  'dominant_frequency_hz',
  'one_x_amplitude',
  'two_x_amplitude',
  'two_x_to_one_x_ratio',
  'spectral_energy'
];
const TASK1_FEATURES = [
  ...VIBRATION_FEATURES,
  'motor_temp_c',
  'pwm_actual',
  'pwm_target'
];
const STORED_FEATURES = [
  'vibration_rms',
  'dominant_frequency_hz',
  'one_x_amplitude',
  'two_x_amplitude',
  'two_x_to_one_x_ratio',
  'spectral_energy'
];
const FAULT_TYPES = new Set([
  'rotor_imbalance',
  'bearing_wear',
  'bearing_fault',
  'cavitation',
  'dry_run',
  'motor_overheat'
]);
const EXPECTED_CLASS_COUNTS = {
  fault: 527879,
  healthy: 101375,
  operating_condition: 158299
};
const EXPECTED_TOTAL_ROWS = 787553;
const EXCLUSION_COLUMNS = [
  'source_file',
  'source_row_number',
  'source_experiment_key',
  'source_record_key',
  'reason'
];
const DEFAULT_OUTPUT = path.join(__dirname, 'task1_rebuilt.csv');
const DEFAULT_EXCLUSIONS = path.join(__dirname, 'task1_rebuild_exclusions.csv');

function parseCsvRecord(line) {
  const fields = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < line.length; i++) {
    const character = line[i];
    if (quoted) {
      if (character === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += character;
      }
    } else if (character === ',' ) {
      fields.push(field);
      field = '';
    } else if (character === '"' && field.length === 0) {
      quoted = true;
    } else if (character === '"') {
      throw new Error('Unexpected quote in an unquoted CSV field');
    } else {
      field += character;
    }
  }

  if (quoted) throw new Error('CSV record contains an unterminated quoted field');
  fields.push(field);
  return fields;
}

async function* readCsvObjects(filePath) {
  const input = fs.createReadStream(filePath, { encoding: 'utf8' });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let headers = null;
  let lineNumber = 0;

  try {
    for await (const line of lines) {
      lineNumber++;
      if (headers === null) {
        headers = parseCsvRecord(line.replace(/^\uFEFF/, ''));
        if (new Set(headers).size !== headers.length) {
          throw new Error(`Duplicate CSV headers in ${filePath}`);
        }
        continue;
      }

      const values = parseCsvRecord(line);
      if (values.length !== headers.length) {
        throw new Error(
          `CSV column count mismatch at ${filePath}:${lineNumber} ` +
          `(expected ${headers.length}, got ${values.length})`
        );
      }
      const row = {};
      for (let i = 0; i < headers.length; i++) row[headers[i]] = values[i];
      yield { row, headers, lineNumber };
    }
  } finally {
    lines.close();
    input.destroy();
  }

  if (headers === null) throw new Error(`CSV is empty: ${filePath}`);
}

function csvValue(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csvLine(values) {
  return `${values.map(csvValue).join(',')}\r\n`;
}

async function writeLine(stream, line) {
  if (!stream.write(line)) await once(stream, 'drain');
}

function numericField(row, name) {
  const value = row[name] === undefined ? '' : row[name].trim();
  if (!value) throw new Error(`missing required value: ${name}`);
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`non-finite ${name}: ${value}`);
  return number;
}

function task1Label(row) {
  const fault = (row.fault_type || '').trim();
  const condition = (row.operating_condition || '').trim();
  const baseline = (row.is_baseline || '').trim().toLowerCase();

  if (fault === 'none' && condition === 'normal' && baseline === 'true') {
    return 'healthy';
  }
  if (fault === 'none' &&
      (condition === 'drought' || condition === 'flood_risk') &&
      baseline === 'false') {
    return 'operating_condition';
  }
  if (FAULT_TYPES.has(fault) && baseline === 'false' &&
      ((fault === 'dry_run' && condition === 'dry_run') ||
       (fault !== 'dry_run' && condition === 'normal'))) {
    return 'fault';
  }

  throw new Error(
    `unmapped or inconsistent labels: fault_type=${fault || '<blank>'}, ` +
    `operating_condition=${condition || '<blank>'}, is_baseline=${baseline || '<blank>'}`
  );
}

function parseWaveform(value) {
  if (!value) throw new Error('missing waveform');
  const tokens = value.split(';');
  const samples = new Array(tokens.length);
  for (let i = 0; i < tokens.length; i++) {
    if (!tokens[i].trim()) throw new Error(`empty waveform sample at index ${i}`);
    samples[i] = Number(tokens[i]);
    if (!Number.isFinite(samples[i])) {
      throw new Error(`non-finite waveform sample at index ${i}`);
    }
  }
  if (samples.length !== 256) {
    throw new Error(`expected 256 waveform samples, got ${samples.length}`);
  }
  return samples;
}

function hashWaveform(serializedWaveform) {
  return crypto.createHash('sha256').update(serializedWaveform, 'utf8').digest('hex');
}

function createStats() {
  return { count: 0, min: Infinity, max: -Infinity, mean: 0, m2: 0 };
}

function addStat(stats, value) {
  stats.count++;
  stats.min = Math.min(stats.min, value);
  stats.max = Math.max(stats.max, value);
  const delta = value - stats.mean;
  stats.mean += delta / stats.count;
  stats.m2 += delta * (value - stats.mean);
}

function statsSummary(stats) {
  if (stats.count === 0) {
    return { count: 0, min: null, max: null, mean: null, stddev: null };
  }
  return {
    count: stats.count,
    min: stats.min,
    max: stats.max,
    mean: stats.mean,
    stddev: Math.sqrt(stats.m2 / stats.count)
  };
}

function newFeatureStats(featureNames) {
  return Object.fromEntries(featureNames.map(name => [name, createStats()]));
}

function compareStats(expected, actual, description, errors) {
  for (const feature of Object.keys(expected)) {
    const a = statsSummary(expected[feature]);
    const b = statsSummary(actual[feature]);
    if (a.count !== b.count || a.min !== b.min || a.max !== b.max ||
        Math.abs(a.mean - b.mean) > 1e-10 ||
        Math.abs(a.stddev - b.stddev) > 1e-10) {
      errors.push(`${description} distribution mismatch for ${feature}`);
    }
  }
}

function parseArgs(args) {
  const options = {
    sources: SOURCES.map(source => ({ ...source })),
    output: DEFAULT_OUTPUT,
    exclusions: DEFAULT_EXCLUSIONS
  };

  for (let i = 0; i < args.length; i++) {
    const option = args[i];
    if (option === '--raw' || option === '--healthy' ||
        option === '--output' || option === '--exclusions') {
      const value = args[++i];
      if (!value) throw new Error(`${option} requires a path`);
      if (option === '--raw') options.sources[0].path = path.resolve(value);
      else if (option === '--healthy') options.sources[1].path = path.resolve(value);
      else if (option === '--output') options.output = path.resolve(value);
      else options.exclusions = path.resolve(value);
    } else if (option === '--help') {
      console.log(
        'Usage: node rebuild_task1_dataset.js ' +
        '[--raw path] [--healthy path] [--output path] [--exclusions path]'
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${option}`);
    }
  }
  return options;
}

function assertTargetAvailable(target) {
  if (!fs.existsSync(path.dirname(target))) {
    throw new Error(`Output directory does not exist: ${path.dirname(target)}`);
  }
  if (fs.existsSync(target)) {
    throw new Error(`Refusing to overwrite existing file: ${target}`);
  }
}

function requiredSourceHeaders(headers, sourceFile) {
  const required = [
    'time_utc', 'experiment_id', 'condition_block_id', 'sample_id',
    'telemetry_id', 'sampling_rate_hz', 'waveform', 'fault_type',
    'operating_condition', 'is_baseline', 'motor_temp_c', 'pwm_actual',
    'pwm_target', 'axis', 'is_multi_axis', 'axes_available'
  ];
  const missing = required.filter(name => !headers.includes(name));
  if (missing.length) {
    throw new Error(`${sourceFile} is missing required columns: ${missing.join(', ')}`);
  }
}

async function validateOutput(
  filePath,
  sourceStats,
  expectedRows,
  expectedClasses,
  expectedSourceCounts,
  sourceRecordKeys,
  sourceWaveformHashes
) {
  const errors = [];
  const featureStats = newFeatureStats(TASK1_FEATURES);
  const classes = { fault: 0, healthy: 0, operating_condition: 0 };
  const sourceCounts = {};
  const recordKeys = new Set();
  const waveformHashes = new Set();
  const required = [
    'source_file', 'source_experiment_key', 'source_record_key', 'time_utc',
    'experiment_id', 'condition_block_id', 'sample_id', 'telemetry_id',
    'sampling_rate_hz', 'waveform_sample_count', 'waveform_sha256',
    'fault_type', 'operating_condition', 'is_baseline', 'task1_label',
    ...TASK1_FEATURES
  ];
  let rowCount = 0;

  for await (const { row, headers } of readCsvObjects(filePath)) {
    if (rowCount === 0 && headers.join(',') !== OUTPUT_COLUMNS.join(',')) {
      errors.push('output header does not match the declared schema');
    }
    rowCount++;
    for (const name of required) {
      if (!row[name] || !row[name].trim()) {
        errors.push(`row ${rowCount}: missing required output field ${name}`);
      }
    }

    if (!Object.hasOwn(classes, row.task1_label)) {
      errors.push(`row ${rowCount}: unknown Task 1 label ${row.task1_label}`);
    } else {
      classes[row.task1_label]++;
    }

    sourceCounts[row.source_file] = (sourceCounts[row.source_file] || 0) + 1;
    if (row.source_record_key !== `${row.source_file}::${row.telemetry_id}`) {
      errors.push(`row ${rowCount}: source_record_key does not match its source ID`);
    }
    if (!sourceRecordKeys.has(row.source_record_key)) {
      errors.push(`row ${rowCount}: source record is absent from the input sources`);
    }
    if (row.source_experiment_key !== `${row.source_file}::${row.experiment_id}`) {
      errors.push(`row ${rowCount}: source_experiment_key does not match its source ID`);
    }
    if (!sourceWaveformHashes.has(row.waveform_sha256)) {
      errors.push(`row ${rowCount}: waveform hash is absent from the input sources`);
    }
    const recordKey = [
      row.source_file, row.experiment_id, row.condition_block_id,
      row.sample_id, row.telemetry_id
    ].join('::');
    if (recordKeys.has(recordKey)) errors.push(`row ${rowCount}: duplicate record key ${recordKey}`);
    recordKeys.add(recordKey);
    if (waveformHashes.has(row.waveform_sha256)) {
      errors.push(`row ${rowCount}: duplicate waveform SHA-256 ${row.waveform_sha256}`);
    }
    waveformHashes.add(row.waveform_sha256);

    for (const feature of TASK1_FEATURES) {
      const value = Number(row[feature]);
      if (!Number.isFinite(value)) {
        errors.push(`row ${rowCount}: invalid feature ${feature}`);
      } else {
        addStat(featureStats[feature], value);
      }
    }
  }

  if (rowCount !== expectedRows) {
    errors.push(`output row count ${rowCount} does not match expected ${expectedRows}`);
  }
  for (const [label, expected] of Object.entries(expectedClasses)) {
    if (classes[label] !== expected) {
      errors.push(`output class count for ${label}: ${classes[label]} (expected ${expected})`);
    }
  }
  for (const [sourceFile, expected] of Object.entries(expectedSourceCounts)) {
    if (sourceCounts[sourceFile] !== expected) {
      errors.push(`output source count for ${sourceFile}: ${sourceCounts[sourceFile] || 0} (expected ${expected})`);
    }
  }
  compareStats(sourceStats, featureStats, 'output/source-derived', errors);

  return {
    errors,
    rowCount,
    classes,
    sourceCounts,
    recordKeyCount: recordKeys.size,
    uniqueWaveformHashes: waveformHashes.size,
    featureDistributions: Object.fromEntries(
      Object.entries(featureStats).map(([name, stats]) => [name, statsSummary(stats)])
    )
  };
}

async function finishStream(stream) {
  await new Promise((resolve, reject) => {
    stream.once('error', reject);
    stream.end(resolve);
  });
}

async function destroyAndWait(stream) {
  if (!stream.destroyed) stream.destroy();
  if (stream.closed) return;
  await new Promise(resolve => stream.once('close', resolve));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  assertTargetAvailable(options.output);
  assertTargetAvailable(options.exclusions);
  if (options.output === options.exclusions) {
    throw new Error('Dataset and exclusion report paths must be different');
  }

  const outputTemp = `${options.output}.tmp-${process.pid}`;
  const exclusionsTemp = `${options.exclusions}.tmp-${process.pid}`;
  const outputStream = fs.createWriteStream(outputTemp, { encoding: 'utf8', flags: 'wx' });
  const exclusionsStream = fs.createWriteStream(exclusionsTemp, { encoding: 'utf8', flags: 'wx' });
  const errors = [];
  const rowCounts = {};
  const classes = { fault: 0, healthy: 0, operating_condition: 0 };
  const subtypeCounts = {};
  const sourceFeatureStats = newFeatureStats(TASK1_FEATURES);
  const storedFeatureStats = newFeatureStats(STORED_FEATURES);
  const storedFeatureMissing = Object.fromEntries(STORED_FEATURES.map(name => [name, 0]));
  const sourceRecordKeys = new Set();
  const sourceExperimentKeys = new Set();
  const waveformHashes = new Set();
  const duplicateRecords = [];
  const duplicateWaveforms = [];
  const exclusionReasons = {};
  let exclusions = 0;
  let sourceRowTotal = 0;

  try {
    await writeLine(outputStream, csvLine(OUTPUT_COLUMNS));
    await writeLine(exclusionsStream, csvLine(EXCLUSION_COLUMNS));

    for (const source of options.sources) {
      if (!fs.existsSync(source.path)) throw new Error(`Source file not found: ${source.path}`);
      rowCounts[source.file] = 0;
      let sourceHeaders = null;

      for await (const record of readCsvObjects(source.path)) {
        const { row, headers, lineNumber } = record;
        sourceRowTotal++;
        rowCounts[source.file]++;
        if (sourceHeaders === null) {
          sourceHeaders = headers;
          requiredSourceHeaders(headers, source.file);
        }

        for (const feature of STORED_FEATURES) {
          const rawValue = row[feature];
          const numericValue = rawValue === undefined || rawValue.trim() === ''
            ? NaN
            : Number(rawValue);
          if (Number.isFinite(numericValue)) addStat(storedFeatureStats[feature], numericValue);
          else storedFeatureMissing[feature]++;
        }

        const experimentId = (row.experiment_id || '').trim();
        const telemetryId = (row.telemetry_id || '').trim();
        const sourceExperimentKey = `${source.file}::${experimentId}`;
        const sourceRecordKey = `${source.file}::${telemetryId}`;
        sourceExperimentKeys.add(sourceExperimentKey);

        let features;
        let taskLabel;
        let samples;
        let samplingRateHz;
        let waveformHash;
        let numericMetadata;
        try {
          for (const idField of [
            'time_utc', 'experiment_id', 'condition_block_id', 'sample_id', 'telemetry_id'
          ]) {
            if (!row[idField] || !row[idField].trim()) {
              throw new Error(`missing required identifier: ${idField}`);
            }
          }

          samplingRateHz = numericField(row, 'sampling_rate_hz');
          if (samplingRateHz !== 1000) {
            throw new Error(`expected sampling rate 1000 Hz, got ${samplingRateHz}`);
          }
          samples = parseWaveform(row.waveform);
          taskLabel = task1Label(row);
          numericMetadata = {
            motor_temp_c: numericField(row, 'motor_temp_c'),
            pwm_actual: numericField(row, 'pwm_actual'),
            pwm_target: numericField(row, 'pwm_target')
          };
          if (row.vibration_rms_unit && row.vibration_rms_unit.trim() !== 'mm/s') {
            throw new Error(`unexpected waveform unit: ${row.vibration_rms_unit}`);
          }
          features = analyzeWaveform(samples, samplingRateHz);
          waveformHash = hashWaveform(row.waveform);
        } catch (error) {
          exclusions++;
          const reason = error.message;
          exclusionReasons[reason] = (exclusionReasons[reason] || 0) + 1;
          await writeLine(exclusionsStream, csvLine([
            source.file,
            lineNumber,
            sourceExperimentKey,
            sourceRecordKey,
            reason
          ]));
          continue;
        }

        if (sourceRecordKeys.has(sourceRecordKey)) {
          duplicateRecords.push(sourceRecordKey);
        }
        sourceRecordKeys.add(sourceRecordKey);
        if (waveformHashes.has(waveformHash)) duplicateWaveforms.push(waveformHash);
        waveformHashes.add(waveformHash);
        classes[taskLabel]++;
        subtypeCounts[row.fault_type] = (subtypeCounts[row.fault_type] || 0) + 1;

        const outputRow = {
          source_file: source.file,
          source_experiment_key: sourceExperimentKey,
          source_record_key: sourceRecordKey,
          time_utc: row.time_utc,
          experiment_id: row.experiment_id,
          condition_block_id: row.condition_block_id,
          sample_id: row.sample_id,
          telemetry_id: row.telemetry_id,
          collection_source: row.collection_source || '',
          axis: row.axis,
          is_multi_axis: row.is_multi_axis,
          axes_available: row.axes_available,
          sampling_rate_hz: row.sampling_rate_hz,
          waveform_sample_count: samples.length,
          waveform_sha256: waveformHash,
          fault_type: row.fault_type,
          operating_condition: row.operating_condition,
          severity_injected: row.severity_injected || '',
          is_baseline: row.is_baseline,
          task1_label: taskLabel,
          ...features,
          ...numericMetadata
        };
        for (const feature of TASK1_FEATURES) addStat(sourceFeatureStats[feature], outputRow[feature]);
        await writeLine(outputStream, csvLine(OUTPUT_COLUMNS.map(name => outputRow[name])));
      }

      if (rowCounts[source.file] !== source.expectedRows) {
        errors.push(
          `${source.file}: read ${rowCounts[source.file]} rows; expected ${source.expectedRows}`
        );
      }
    }

    await finishStream(outputStream);
    await finishStream(exclusionsStream);

    if (sourceRowTotal !== EXPECTED_TOTAL_ROWS) {
      errors.push(`source row count ${sourceRowTotal}; expected ${EXPECTED_TOTAL_ROWS}`);
    }
    if (exclusions > 0) {
      errors.push(`${exclusions} source rows could not be safely included`);
    }
    if (duplicateRecords.length > 0) {
      errors.push(`${duplicateRecords.length} duplicate source record keys`);
    }
    if (duplicateWaveforms.length > 0) {
      errors.push(`${duplicateWaveforms.length} duplicate waveform hashes`);
    }
    for (const [label, expected] of Object.entries(EXPECTED_CLASS_COUNTS)) {
      if (classes[label] !== expected) {
        errors.push(`source-derived class count for ${label}: ${classes[label]} (expected ${expected})`);
      }
    }

    const validation = await validateOutput(
      outputTemp,
      sourceFeatureStats,
      EXPECTED_TOTAL_ROWS,
      EXPECTED_CLASS_COUNTS,
      rowCounts,
      sourceRecordKeys,
      waveformHashes
    );
    errors.push(...validation.errors);

    if (errors.length > 0) {
      if (fs.existsSync(options.exclusions)) {
        throw new Error(`Cannot save exclusion report because it already exists: ${options.exclusions}`);
      }
      fs.renameSync(exclusionsTemp, options.exclusions);
      fs.unlinkSync(outputTemp);
      const reasons = Object.entries(exclusionReasons)
        .map(([reason, count]) => `${count} x ${reason}`)
        .join('; ') || 'none';
      throw new Error(
        `Validation failed; dataset was not promoted. ${errors.join(' | ')}. ` +
        `Exclusions: ${reasons}. Exclusion report: ${options.exclusions}`
      );
    }

    fs.renameSync(exclusionsTemp, options.exclusions);
    fs.renameSync(outputTemp, options.output);

    const legacyDistributions = Object.fromEntries(
      Object.entries(storedFeatureStats)
        .map(([name, stats]) => [name, statsSummary(stats)])
    );
    console.log(JSON.stringify({
      result: 'validated',
      output: options.output,
      exclusions_report: options.exclusions,
      source_rows: rowCounts,
      total_rows: validation.rowCount,
      excluded_rows: exclusions,
      class_counts: validation.classes,
      fault_subtypes: subtypeCounts,
      missing_required_output_values: 0,
      duplicate_source_records: duplicateRecords.length,
      duplicate_waveform_hashes: duplicateWaveforms.length,
      unique_output_waveform_hashes: validation.uniqueWaveformHashes,
      output_feature_distributions: validation.featureDistributions,
      source_precomputed_feature_distributions: legacyDistributions,
      missing_or_invalid_source_precomputed_features: storedFeatureMissing,
      source_experiment_groups: sourceExperimentKeys.size,
      source_grouping_key: 'source_file::experiment_id'
    }, null, 2));
  } catch (error) {
    await Promise.all([
      destroyAndWait(outputStream),
      destroyAndWait(exclusionsStream)
    ]);
    for (const tempPath of [outputTemp, exclusionsTemp]) {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    }
    throw error;
  }
}

main().catch(error => {
  console.error(`[TASK1 REBUILD] ${error.message}`);
  process.exitCode = 1;
});
