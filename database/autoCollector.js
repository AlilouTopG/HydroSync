const PWM_TARGETS = [40, 50, 60, 70, 80];
const HEALTHY_GRID_AMBIENT_TEMPS = [20, 25, 30, 35, 40];
const HEALTHY_GRID_TANK_LEVELS = [80, 85, 90];
const HEALTHY_GRID_REPEATS = 10;
const HEALTHY_GRID_SAMPLES_PER_BLOCK = 100;
const AMBIENT_TEMPERATURES_C = [20, 25, 30, 35, 40];
const TANK_LEVELS_PCT = [70, 80, 90];
const MIN_SETTLING_TICKS = 30;
const SETTLING_WINDOW_TICKS = 10;
const MAX_SETTLING_TICKS = 120;
const { analyzeWaveform } = require('./vibrationAnalysis');
const conditionSetup = require('./conditionSetup');
const { randomInt } = require('crypto');

const CONDITIONS = [
  {
    id: 'baseline',
    faultType: 'none',
    severity: 0,
    operatingCondition: 'normal',
    isBaseline: true,
    setup: conditionSetup.setupHealthy
  },
  ...[10, 25, 50, 75, 100].map(severity => ({
    id: `rotor_imbalance-${severity}`,
    faultType: 'rotor_imbalance',
    severity,
    operatingCondition: 'normal',
    isBaseline: false,
    setup: conditionSetup.setupRotorImbalance
  })),
  ...[25, 60, 90].map(severity => ({
    id: `bearing_wear-${severity}`,
    faultType: 'bearing_wear',
    severity,
    operatingCondition: 'normal',
    isBaseline: false,
    setup: conditionSetup.setupBearingWear
  })),
  ...[50, 75, 100].map(severity => ({
    id: `bearing_fault-${severity}`,
    faultType: 'bearing_fault',
    severity,
    operatingCondition: 'normal',
    isBaseline: false,
    setup: conditionSetup.setupBearingFault
  })),
  ...[25, 50, 75, 95].map(severity => ({
    id: `cavitation-${severity}`,
    faultType: 'cavitation',
    severity,
    operatingCondition: 'normal',
    isBaseline: false,
    setup: conditionSetup.setupCavitation
  })),
  ...[50, 100].map(severity => ({
    id: `motor_overheat-${severity}`,
    faultType: 'motor_overheat',
    severity,
    operatingCondition: 'normal',
    isBaseline: false,
    setup: conditionSetup.setupMotorOverheat
  })),
  {
    id: 'dry_run',
    faultType: 'dry_run',
    severity: 0,
    operatingCondition: 'dry_run',
    isBaseline: false,
    setup: conditionSetup.setupDryRun
  },
  {
    id: 'drought',
    faultType: 'none',
    severity: 0,
    operatingCondition: 'drought',
    isBaseline: false,
    setup: conditionSetup.setupDrought
  },
  {
    id: 'flood_risk',
    faultType: 'none',
    severity: 0,
    operatingCondition: 'flood_risk',
    isBaseline: false,
    setup: conditionSetup.setupFloodRisk
  }
];

function parseAutoCollectOptions(args) {
  if (!args.includes('--auto-collect')) return null;

  const options = {
    repeats: 1,
    samplesPerBlock: 50,
    healthyGrid: false,
    healthyGridRepeats: HEALTHY_GRID_REPEATS
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--auto-collect') continue;
    if (arg === '--healthy-grid') {
      options.healthyGrid = true;
      continue;
    }
    if (
      arg !== '--repeats' &&
      arg !== '--samples-per-block' &&
      arg !== '--healthy-grid-repeats'
    ) continue;

    const value = args[++i];
    if (!value || !/^[1-9]\d*$/.test(value)) {
      throw new Error(`${arg} requires a positive integer`);
    }
    const optionKey = arg === '--repeats'
      ? 'repeats'
      : arg === '--samples-per-block'
        ? 'samplesPerBlock'
        : 'healthyGridRepeats';
    options[optionKey] = Number(value);
  }

  return options;
}

async function runAutoCollection({
  simulator,
  telemetryCollector,
  repeats,
  samplesPerBlock,
  healthyGrid = false,
  healthyGridRepeats = HEALTHY_GRID_REPEATS,
  onSample = () => {},
  logger = console
}) {
  let sampleId = 0;
  let blockCount = 0;
  const totalBlocks = healthyGrid ? 0 : repeats * PWM_TARGETS.length * CONDITIONS.length;
  const healthyGridBlocksPerRepeat =
    PWM_TARGETS.length *
    HEALTHY_GRID_AMBIENT_TEMPS.length *
    HEALTHY_GRID_TANK_LEVELS.length;
  const totalHealthyGridBlocks = healthyGrid
    ? healthyGridRepeats * healthyGridBlocksPerRepeat
    : 0;

  function operatingParameters(repeat, conditionIndex, pwmIndex, ambientShift, tankShift) {
    // Seeded cyclic shifts balance the levels within a run and change them
    // across separately launched experiments as well as repeat sweeps.
    return {
      ambientTemp: AMBIENT_TEMPERATURES_C[
        (ambientShift + repeat - 1 + conditionIndex + pwmIndex * 2) % AMBIENT_TEMPERATURES_C.length
      ],
      tankVolumePct: TANK_LEVELS_PCT[
        (tankShift + repeat - 1 + conditionIndex + pwmIndex) % TANK_LEVELS_PCT.length
      ]
    };
  }

  async function waitForSettling(blockId, pwmTarget) {
    const history = [];
    for (let tick = 1; tick <= MAX_SETTLING_TICKS; tick++) {
      simulator.pidLoop();
      const state = simulator.getState();
      const signals = {
        pumpDuty: Number(state.pumpDuty),
        flowRate: Number(state.flowRate),
        vibrationRms: Number(state.assetHealth?.vibrationRms),
        motorTemp: Number(state.motorTemp)
      };
      history.push(signals);
      if (history.length > SETTLING_WINDOW_TICKS) history.shift();
      if (tick < MIN_SETTLING_TICKS || history.length < SETTLING_WINDOW_TICKS) continue;

      const values = Object.keys(signals);
      const stable = history.every(row => Math.abs(row.pumpDuty - pwmTarget) <= 0.5) &&
        values.slice(1).every(key => {
          const series = history.map(row => row[key]);
          return Math.max(...series) - Math.min(...series) <=
            (key === 'motorTemp' ? 0.5 : key === 'vibrationRms' ? 0.25 : 0.1);
        });
      if (stable) return { settlingTicks: tick, stableStartTick: tick - SETTLING_WINDOW_TICKS + 1 };
    }
    throw new Error(`Block ${blockId} did not settle within ${MAX_SETTLING_TICKS} simulator ticks`);
  }

  try {
    if (!healthyGrid) for (let repeat = 1; repeat <= repeats; repeat++) {
      const designSeed = randomInt(1, 0x7fffffff);
      const ambientShift = designSeed % AMBIENT_TEMPERATURES_C.length;
      const tankShift = Math.floor(designSeed / AMBIENT_TEMPERATURES_C.length) %
        TANK_LEVELS_PCT.length;
      let shuffleState = designSeed;
      const random = () => {
        shuffleState = (shuffleState * 48271) % 0x7fffffff;
        return shuffleState / 0x7fffffff;
      };
      const blocks = [];
      for (let pwmIndex = 0; pwmIndex < PWM_TARGETS.length; pwmIndex++) {
        for (let conditionIndex = 0; conditionIndex < CONDITIONS.length; conditionIndex++) {
          blocks.push({
            pwmTarget: PWM_TARGETS[pwmIndex],
            pwmIndex,
            condition: CONDITIONS[conditionIndex],
            conditionIndex,
            parameters: operatingParameters(
              repeat,
              conditionIndex,
              pwmIndex,
              ambientShift,
              tankShift
            )
          });
        }
      }
      for (let i = blocks.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [blocks[i], blocks[j]] = [blocks[j], blocks[i]];
      }
      await telemetryCollector.startExperiment({
        name: `auto_collect_${new Date().toISOString()}_repeat_${repeat}`,
        description: `Automated simulator dataset collection repeat ${repeat} of ${repeats}`,
        source: 'simulator',
        metadata: {
          design_id: 'hydrosync-factorial-v2',
          repeats,
          repeat,
          design_seed: designSeed,
          samples_per_block: samplesPerBlock,
          collection_source: 'auto-collect',
          parameter_design: {
            ambient_temperatures_c: AMBIENT_TEMPERATURES_C,
            tank_levels_pct: TANK_LEVELS_PCT,
            assignment: 'seeded-balanced-cycle-by-repeat-condition-and-pwm',
            ambient_shift: ambientShift,
            tank_shift: tankShift
          },
          settling_rule: {
            minimum_ticks: MIN_SETTLING_TICKS,
            consecutive_ticks: SETTLING_WINDOW_TICKS,
            maximum_ticks: MAX_SETTLING_TICKS,
            signals: ['pumpDuty', 'flowRate', 'vibrationRms', 'motorTemp']
          }
        }
      });

      for (const block of blocks) {
          const { pwmTarget, pwmIndex, condition, conditionIndex, parameters } = block;
          blockCount++;
          const blockId = `repeat-${repeat}-pwm-${pwmTarget}-${condition.id}`;

          condition.setup(simulator, condition.severity, {
            ...parameters,
            disturbanceDurationTicks: MAX_SETTLING_TICKS + samplesPerBlock + 1,
            ...(condition.id.startsWith('cavitation-') || condition.id === 'dry_run'
              ? { tankVolumePct: undefined }
              : {})
          });
          const tankVolumePctApplied = Number(simulator.getState().tankVolumePct);
          simulator.setManualMode(true, pwmTarget);
          const settling = await waitForSettling(blockId, pwmTarget);

          logger.log(
            `[RUNNER] Starting block ${blockCount}/${totalBlocks}: ` +
            `PWM ${pwmTarget}, ${condition.faultType}/${condition.severity}`
          );

          for (let sampleInBlock = 1; sampleInBlock <= samplesPerBlock; sampleInBlock++) {
            simulator.pidLoop();
            const state = {
              ...simulator.getState(),
              datasetCondition: {
                fault_type: condition.faultType,
                operating_condition: condition.operatingCondition,
                severity_injected: condition.severity,
                condition_block_id: blockId,
                pwm_target: pwmTarget,
                ambient_temp_c: state.ambientTemp,
                ambient_temp_target_c: parameters.ambientTemp,
                tank_volume_pct_target: tankVolumePctApplied,
                tank_volume_pct_design_level: parameters.tankVolumePct,
                stable: true,
                stable_start_tick: settling.stableStartTick,
                settling_ticks: settling.settlingTicks,
                is_baseline: condition.isBaseline,
                sample_id: ++sampleId
              }
            };
            if (Number(state.pumpDuty) < 40) {
              throw new Error(`PWM fell below 40% while collecting ${blockId}`);
            }
            const samplingRateHz = Number(
              state.samplingRateHz || state.assetHealth?.samplingRateHz
            );
            const vibrationFeatures = analyzeWaveform(
              state.vibrationWaveform,
              samplingRateHz
            );

            await telemetryCollector.recordTelemetry(state, {
              features: vibrationFeatures
            }, {
              collectionSource: 'auto-collect'
            });
            await onSample(state);

            if (sampleInBlock % 10 === 0 || sampleInBlock === samplesPerBlock) {
              logger.log(
                `[RUNNER] Block ${blockCount}/${totalBlocks}: ` +
                `${sampleInBlock}/${samplesPerBlock} samples written`
              );
            }
          }
      }
    }

    let healthyGridSampleCount = 0;
    if (healthyGrid) {
    for (let repeat = 1; repeat <= healthyGridRepeats; repeat++) {
      await telemetryCollector.startExperiment({
        name: `healthy_grid_${new Date().toISOString()}_repeat_${repeat}`,
        description: `Healthy operating grid experiment ${repeat} of ${healthyGridRepeats}`,
        source: 'simulator',
        metadata: {
          design_id: 'hydrosync-healthy-grid-v1',
          repeats: healthyGridRepeats,
          repeat,
          samples_per_block: HEALTHY_GRID_SAMPLES_PER_BLOCK,
          collection_source: 'healthy_grid',
          pwm_targets: PWM_TARGETS,
          ambient_temperatures_c: HEALTHY_GRID_AMBIENT_TEMPS,
          tank_volume_levels_pct: HEALTHY_GRID_TANK_LEVELS,
          settling_rule: {
            minimum_ticks: MIN_SETTLING_TICKS,
            consecutive_ticks: SETTLING_WINDOW_TICKS,
            maximum_ticks: MAX_SETTLING_TICKS
          }
        }
      });

      for (const pwmTarget of PWM_TARGETS) {
        for (const ambientTemp of HEALTHY_GRID_AMBIENT_TEMPS) {
          for (const tankVolumePct of HEALTHY_GRID_TANK_LEVELS) {
            blockCount++;
            const blockId =
              `healthy-grid-repeat-${repeat}-pwm-${pwmTarget}-ambient-${ambientTemp}-tank-${tankVolumePct}`;

          simulator.prepareAutoCollectionBlock({ ambientTemp });
          conditionSetup.setupHealthy(simulator, { alreadyPrepared: true });
            simulator.setTankVolumePercent(tankVolumePct);
            simulator.setManualMode(true, pwmTarget);

            const settling = await waitForSettling(blockId, pwmTarget);

            logger.log(
              `[RUNNER] Healthy grid block ${blockCount - totalBlocks}/` +
              `${totalHealthyGridBlocks}: PWM ${pwmTarget}, ambient ${ambientTemp}°C, ` +
              `tank ${tankVolumePct}%`
            );

            for (
              let sampleInBlock = 1;
              sampleInBlock <= HEALTHY_GRID_SAMPLES_PER_BLOCK;
              sampleInBlock++
            ) {
              simulator.pidLoop();
              const state = {
                ...simulator.getState(),
                datasetCondition: {
                  fault_type: 'none',
                  operating_condition: 'normal',
                  severity_injected: 0,
                  condition_block_id: blockId,
                  pwm_target: pwmTarget,
                  is_baseline: true,
                  ambient_temp_c: ambientTemp,
                  ambient_temp_target_c: ambientTemp,
                  tank_volume_pct_target: tankVolumePct,
                  tank_volume_pct_design_level: tankVolumePct,
                  stable: true,
                  stable_start_tick: settling.stableStartTick,
                  settling_ticks: settling.settlingTicks,
                  sample_id: ++sampleId
                }
              };
              if (Number(state.pumpDuty) < 40) {
                throw new Error(`PWM fell below 40% while collecting ${blockId}`);
              }
              const samplingRateHz = Number(
                state.samplingRateHz || state.assetHealth?.samplingRateHz
              );
              const vibrationFeatures = analyzeWaveform(
                state.vibrationWaveform,
                samplingRateHz
              );

              await telemetryCollector.recordTelemetry(state, {
                features: vibrationFeatures
              }, {
                collectionSource: 'healthy_grid'
              });
              await onSample(state);
              healthyGridSampleCount++;

              if (
                sampleInBlock % 1000 === 0 ||
                sampleInBlock === HEALTHY_GRID_SAMPLES_PER_BLOCK
              ) {
                logger.log(
                  `[RUNNER] Healthy grid block ${blockCount - totalBlocks}/` +
                  `${totalHealthyGridBlocks}: ${sampleInBlock}/` +
                  `${HEALTHY_GRID_SAMPLES_PER_BLOCK} samples written`
                );
              }
            }
          }
        }
      }
    }
    }

    const totalBlocksCollected = totalBlocks + totalHealthyGridBlocks;
    logger.log(
      `[RUNNER] Collection complete: ${sampleId} samples across ` +
      `${totalBlocksCollected} blocks (${healthyGridSampleCount} healthy-grid samples)`
    );
    return {
      samples: sampleId,
      blocks: totalBlocksCollected,
      healthyGridSamples: healthyGridSampleCount,
      healthyGridBlocks: totalHealthyGridBlocks
    };
  } finally {
    simulator.injectFault('clear');
    simulator.setImbalanceLevel(0);
    simulator.setManualMode(false, 0);
    simulator.finishAutoCollection();
  }
}

module.exports = { parseAutoCollectOptions, runAutoCollection };
