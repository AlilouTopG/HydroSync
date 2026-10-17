const CAVITATION_TANK_VOLUME_PCT_BY_SEVERITY = new Map([
  [25, 18],
  [50, 19.2],
  [75, 9.5],
  [95, 5.5]
]);

function beginCondition(simulator, ambientTemp, imbalanceLevel = 0, {
  alreadyPrepared = false,
  tankVolumePct
} = {}) {
  if (!alreadyPrepared) {
    simulator.prepareAutoCollectionBlock(
      ambientTemp === undefined ? undefined : { ambientTemp }
    );
  }
  simulator.injectFault('clear');
  simulator.setImbalanceLevel(imbalanceLevel);
  if (tankVolumePct !== undefined) simulator.setTankVolumePercent(tankVolumePct);
}

function setupHealthy(simulator, _severity, options = {}) {
  if (_severity && typeof _severity === 'object') options = _severity;
  beginCondition(simulator, options.ambientTemp, 0, options);
}

function setupRotorImbalance(simulator, severity, options = {}) {
  beginCondition(simulator, options.ambientTemp, severity, options);
}

function setupBearingWear(simulator, severity, options = {}) {
  beginCondition(simulator, options.ambientTemp, 0, options);
  simulator.setBearingWearLevel(severity);
}

function setupBearingFault(simulator, _severity, options = {}) {
  beginCondition(simulator, options.ambientTemp, 0, options);
  simulator.injectFault('bearing');
}

function setupCavitation(
  simulator,
  severity,
  { alreadyPrepared = false, tankVolumePct: tankVolumeOverride, ambientTemp } = {}
) {
  const tankVolumePct = tankVolumeOverride ??
    CAVITATION_TANK_VOLUME_PCT_BY_SEVERITY.get(severity);
  if (tankVolumePct === undefined) {
    throw new Error(`Unsupported cavitation severity: ${severity}`);
  }

  beginCondition(simulator, ambientTemp, 0, { alreadyPrepared });
  simulator.setTankVolumePercent(tankVolumePct);
}

function setupMotorOverheat(simulator, severity, options = {}) {
  beginCondition(simulator, options.ambientTemp ?? 24, 0, options);
  simulator.setThermalFaultLevel(severity);
}

function setupDryRun(simulator, _severity, options = {}) {
  beginCondition(simulator, options.ambientTemp, 0, { ...options, tankVolumePct: 9.5 });
}

function setupDrought(simulator, _severity, options = {}) {
  beginCondition(simulator, options.ambientTemp, 0, options);
  simulator.injectDisturbance('drought', options.disturbanceDurationTicks);
}

function setupFloodRisk(simulator, _severity, options = {}) {
  beginCondition(simulator, options.ambientTemp ?? 21, 0, options);
  simulator.injectDisturbance('flood', options.disturbanceDurationTicks);
}

module.exports = {
  setupHealthy,
  setupRotorImbalance,
  setupBearingWear,
  setupBearingFault,
  setupCavitation,
  setupMotorOverheat,
  setupDryRun,
  setupDrought,
  setupFloodRisk
};
