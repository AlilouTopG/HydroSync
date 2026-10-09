const PWM_TARGETS = [40, 50, 60, 70, 80];
const { analyzeWaveform } = require('./vibrationAnalysis');

const CONDITIONS = [
  {
    id: 'baseline',
    faultType: 'none',
    severity: 0,
    operatingCondition: 'normal',
    isBaseline: true
  },
  ...[10, 25, 50, 75, 100].map(severity => ({
    id: `rotor_imbalance-${severity}`,
    faultType: 'rotor_imbalance',
    severity,
    operatingCondition: 'normal',
    isBaseline: false,
    imbalanceLevel: severity
  })),
  ...[25, 60, 90].map(severity => ({
    id: `bearing_wear-${severity}`,
    faultType: 'bearing_wear',
    severity,
    operatingCondition: 'normal',
    isBaseline: false,
    bearingWearLevel: severity
  })),
  ...[50, 75, 100].map(severity => ({
    id: `bearing_fault-${severity}`,
    faultType: 'bearing_fault',
    severity,
    operatingCondition: 'normal',
    isBaseline: false,
    bearingFault: true
  })),
  ...[25, 50, 75, 95].map(severity => ({
    id: `cavitation-${severity}`,
    faultType: 'cavitation',
    severity,
    operatingCondition: 'normal',
    isBaseline: false,
    tankVolumePct: {
      25: 18,
      50: 19.2,
      75: 9.5,
      95: 5.5
    }[severity]
  })),
  ...[50, 100].map(severity => ({
    id: `motor_overheat-${severity}`,
    faultType: 'motor_overheat',
    severity,
    operatingCondition: 'normal',
    isBaseline: false,
    overheatFault: true,
    ambientTemp: 24
  })),
  {
    id: 'dry_run',
    faultType: 'dry_run',
    severity: 0,
    operatingCondition: 'dry_run',
    isBaseline: false,
    tankVolumePct: 9.5
  },
  {
    id: 'drought',
    faultType: 'none',
    severity: 0,
    operatingCondition: 'drought',
    isBaseline: false,
    disturbance: 'drought'
  },
  {
    id: 'flood_risk',
    faultType: 'none',
    severity: 0,
    operatingCondition: 'flood_risk',
    isBaseline: false,
    disturbance: 'flood',
    ambientTemp: 21
  }
];

function parseAutoCollectOptions(args) {
  if (!args.includes('--auto-collect')) return null;

  const options = { repeats: 1, samplesPerBlock: 50 };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--auto-collect') continue;
    if (arg !== '--repeats' && arg !== '--samples-per-block') continue;

    const value = args[++i];
    if (!value || !/^[1-9]\d*$/.test(value)) {
      throw new Error(`${arg} requires a positive integer`);
    }
    options[arg === '--repeats' ? 'repeats' : 'samplesPerBlock'] = Number(value);
  }

  return options;
}

async function runAutoCollection({
  simulator,
  telemetryCollector,
  repeats,
  samplesPerBlock,
  onSample = () => {},
  logger = console
}) {
  let sampleId = 0;
  let blockCount = 0;
  const totalBlocks = repeats * PWM_TARGETS.length * CONDITIONS.length;

  try {
    for (let repeat = 1; repeat <= repeats; repeat++) {
      await telemetryCollector.startExperiment({
        name: `auto_collect_${new Date().toISOString()}_repeat_${repeat}`,
        description: `Automated simulator dataset collection repeat ${repeat} of ${repeats}`,
        source: 'simulator',
        metadata: {
          repeats,
          repeat,
          samples_per_block: samplesPerBlock,
          collection_source: 'auto-collect'
        }
      });

      for (const pwmTarget of PWM_TARGETS) {
        for (const condition of CONDITIONS) {
          blockCount++;
          const blockId = `repeat-${repeat}-pwm-${pwmTarget}-${condition.id}`;

          simulator.prepareAutoCollectionBlock(
            condition.ambientTemp === undefined
              ? undefined
              : { ambientTemp: condition.ambientTemp }
          );
          simulator.injectFault('clear');
          simulator.setImbalanceLevel(condition.imbalanceLevel || 0);
          if (condition.bearingWearLevel !== undefined) {
            simulator.setBearingWearLevel(condition.bearingWearLevel);
          }
          if (condition.bearingFault) simulator.injectFault('bearing');
          if (condition.tankVolumePct !== undefined) {
            simulator.setTankVolumePercent(condition.tankVolumePct);
          }
          if (condition.overheatFault) simulator.setThermalFaultLevel(condition.severity);
          if (condition.disturbance) simulator.injectDisturbance(condition.disturbance);
          simulator.setManualMode(true, pwmTarget);

          let warmupTicks = 0;
          while (warmupTicks < 10) {
            simulator.pidLoop();
            const warmedState = simulator.getState();
            if (Number(warmedState.pumpDuty) === pwmTarget) break;
            warmupTicks++;
          }
          if (Number(simulator.getState().pumpDuty) !== pwmTarget) {
            throw new Error(`PWM failed to reach ${pwmTarget}% before collecting ${blockId}`);
          }

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
    }

    logger.log(`[RUNNER] Collection complete: ${sampleId} samples across ${totalBlocks} blocks`);
    return { samples: sampleId, blocks: totalBlocks };
  } finally {
    simulator.injectFault('clear');
    simulator.setImbalanceLevel(0);
    simulator.setManualMode(false, 0);
    simulator.finishAutoCollection();
  }
}

module.exports = { parseAutoCollectOptions, runAutoCollection };
