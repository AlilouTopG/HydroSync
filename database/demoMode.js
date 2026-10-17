const { randomUUID } = require('crypto');

// ─── Demo Mode ────────────────────────────────────────────────────────────
// Drives the simulator through all 9 trained states × 5 PWM values (40/50/60/70/80).
// Each state runs for 60 seconds of warm-up followed by 30 seconds of measurement.
// Full cycle = 67.5 minutes, then repeats.
// Runs the safety interlock bypass so overheat can reach its trained temperature.
//
// Usage:
//   const demo = require('./database/demoMode');
//   demo.start(simulator);
//   demo.stop();

const DEFAULT_DEMO_WARMUP_MS = 60_000;
const DEFAULT_DEMO_MEASURE_MS = 30_000;
const QUICK_DEMO_WARMUP_MS = 30_000;
const QUICK_DEMO_MEASURE_MS = 15_000;
const DEMO_DISTURBANCE_SAFETY_TICKS = 5;
const FULL_PWM_LEVELS = [40, 50, 60, 70, 80];
const QUICK_PWM_LEVELS = [40, 60, 80];
const conditionSetup = require('./conditionSetup');

const STATES = [
  {
    name: 'healthy', setup: conditionSetup.setupHealthy,
    faultType: 'none', operatingCondition: 'normal', severityInjected: 0, isBaseline: true
  },
  {
    name: 'rotor_imbalance', setup: conditionSetup.setupRotorImbalance, severity: 50,
    faultType: 'rotor_imbalance', operatingCondition: 'normal', severityInjected: 50, isBaseline: false
  },
  {
    name: 'bearing_wear', setup: conditionSetup.setupBearingWear, severity: 60,
    faultType: 'bearing_wear', operatingCondition: 'normal', severityInjected: 60, isBaseline: false
  },
  {
    name: 'bearing_fault', setup: conditionSetup.setupBearingFault,
    faultType: 'bearing_fault', operatingCondition: 'normal', severityInjected: null, isBaseline: false
  },
  {
    name: 'cavitation',
    setup: conditionSetup.setupCavitation,
    severity: 25,
    setupOptions: { tankVolumePct: 23 },
    faultType: 'cavitation', operatingCondition: 'normal', severityInjected: 25, isBaseline: false
  },
  {
    name: 'motor_overheat', setup: conditionSetup.setupMotorOverheat, severity: 84,
    faultType: 'motor_overheat', operatingCondition: 'normal', severityInjected: 84, isBaseline: false
  },
  {
    name: 'dry_run',
    setup: conditionSetup.setupDryRun,
    setupOptions: { tankVolumePct: 8 },
    faultType: 'dry_run', operatingCondition: 'dry_run', severityInjected: 0, isBaseline: false
  },
  {
    name: 'drought', setup: conditionSetup.setupDrought,
    faultType: 'none', operatingCondition: 'drought', severityInjected: 0, isBaseline: false
  },
  {
    name: 'flood_risk', setup: conditionSetup.setupFloodRisk,
    faultType: 'none', operatingCondition: 'flood_risk', severityInjected: 0, isBaseline: false
  },
];

let running = false;
let timeoutHandle = null;
let cycleIndex = 0;
let simulatorRef = null;
let onStateChange = null;   // optional callback({ state, pwm, cycle, phase })
let demoWarmupMs = DEFAULT_DEMO_WARMUP_MS;
let demoMeasureMs = DEFAULT_DEMO_MEASURE_MS;
let maxCycles = 1;
let pwmLevels = FULL_PWM_LEVELS;
let runStatus = {
  running: false,
  runId: null,
  mode: null,
  phase: 'idle',
  state: null,
  pwm: null,
  completedBlocks: 0,
  totalBlocks: 0,
  completed: false
};

function start(simulator, options = {}) {
  return startConfigured(simulator, options, 'full', FULL_PWM_LEVELS);
}

function startQuick(simulator, options = {}) {
  return startConfigured(simulator, {
    ...options,
    demo_warmup_ms: QUICK_DEMO_WARMUP_MS,
    demo_measure_ms: QUICK_DEMO_MEASURE_MS,
    maxCycles: 1
  }, 'quick', QUICK_PWM_LEVELS);
}

function startConfigured(simulator, options, mode, selectedPwmLevels) {
  if (running) return { started: false, reason: 'already running' };
  if (!simulator) return { started: false, reason: 'no simulator' };

  const requestedWarmupMs = options.demo_warmup_ms ?? DEFAULT_DEMO_WARMUP_MS;
  const requestedMeasureMs = options.demo_measure_ms ?? DEFAULT_DEMO_MEASURE_MS;
  if (!Number.isFinite(requestedWarmupMs) || requestedWarmupMs <= 0 ||
      !Number.isFinite(requestedMeasureMs) || requestedMeasureMs <= 0) {
    return { started: false, reason: 'demo phase durations must be positive finite numbers' };
  }

  demoWarmupMs = requestedWarmupMs;
  demoMeasureMs = requestedMeasureMs;
  pwmLevels = selectedPwmLevels;
  simulatorRef = simulator;
  onStateChange = options.onStateChange || null;
  const runId = randomUUID();
  maxCycles = Number(options.maxCycles) || 1;
  const totalBlocks = STATES.length * pwmLevels.length * Math.ceil(maxCycles);

  // Enter demo mode first (bypasses interlocks, raises thermal trip threshold to 130 °C).
  simulator.setDemoMode(true);
  running = true;
  cycleIndex = 0;
  runStatus = {
    running: true,
    runId,
    mode,
    phase: 'warmup',
    state: null,
    pwm: null,
    completedBlocks: 0,
    totalBlocks,
    completed: false,
    warmupMs: demoWarmupMs,
    measureMs: demoMeasureMs
  };
  runCurrent();   // start the first state's warm-up immediately

  return {
    started: true,
    runId,
    mode,
    pwmLevels,
    totalStates: STATES.length * pwmLevels.length,
    demo_warmup_ms: demoWarmupMs,
    demo_measure_ms: demoMeasureMs,
    estimatedRuntimeMs: totalBlocks * (demoWarmupMs + demoMeasureMs)
  };
}

function runCurrent() {
  if (!simulatorRef) return;

  const pwmIdx   = Math.floor(cycleIndex / STATES.length) % pwmLevels.length;
  const stateIdx = cycleIndex % STATES.length;
  const stateCfg = STATES[stateIdx];
  const pwm      = pwmLevels[pwmIdx];

  const disturbanceDurationTicks = Math.ceil(
    (demoWarmupMs + demoMeasureMs) / 1000
  ) + DEMO_DISTURBANCE_SAFETY_TICKS;
  stateCfg.setup(simulatorRef, stateCfg.severity, {
    ...stateCfg.setupOptions,
    ...(stateCfg.operatingCondition === 'drought' || stateCfg.operatingCondition === 'flood_risk'
      ? { disturbanceDurationTicks }
      : {})
  });
  simulatorRef.setManualMode(true, pwm);

  const cycleNum = Math.floor(cycleIndex / (STATES.length * pwmLevels.length)) + 1;
  const label = `[DEMO:${runStatus.mode}] ${stateCfg.name.padEnd(18)} | PWM ${pwm}`;
  console.log(label);

  notifyStateChange(stateCfg, pwm, cycleNum, 'warmup');

  // warmup phase
  timeoutHandle = setTimeout(() => {
    timeoutHandle = null;
    if (!running) return;

    notifyStateChange(stateCfg, pwm, cycleNum, 'measurement');

    // measurement phase
    timeoutHandle = setTimeout(() => {
      timeoutHandle = null;
      if (!running) return;

      runStatus.completedBlocks++;
      cycleIndex++;

      // auto-stop after maxCycles full sweeps
      const totalSubCycles = STATES.length * pwmLevels.length;
      const completedCycles = Math.floor(cycleIndex / totalSubCycles);
      if (completedCycles >= maxCycles) {
        console.log(`[DEMO] completed ${completedCycles} cycle(s) — stopping automatically`);
        runStatus.completed = true;
        stop();
        return;
      }

      runCurrent();
    }, demoMeasureMs);
  }, demoWarmupMs);
}


function notifyStateChange(stateCfg, pwm, cycle, phase) {
  runStatus.phase = phase;
  runStatus.state = stateCfg.name;
  runStatus.pwm = pwm;
  if (!onStateChange) return;
  try {
    onStateChange({
      state: stateCfg.name,
      pwm,
      cycle,
      phase,
      faultType: stateCfg.faultType,
      operatingCondition: stateCfg.operatingCondition,
      severityInjected: stateCfg.severityInjected,
      isBaseline: stateCfg.isBaseline,
      runId: runStatus.runId,
      mode: runStatus.mode
    });
  } catch (error) {
    console.error('[DEMO] state-change callback failed:', error.message);
  }
}

function stop() {
  if (!running) return { stopped: false, reason: 'not running' };

  running = false;
  if (timeoutHandle) { clearTimeout(timeoutHandle); timeoutHandle = null; }
  runStatus.running = false;
  runStatus.phase = runStatus.completed ? 'complete' : 'stopped';

  if (simulatorRef) {
    try { simulatorRef.setDemoMode(false); } catch (_) {}
    try {
      // Clean up: restore safe defaults via autoCollector teardown pattern.
      simulatorRef.injectFault('clear');
      simulatorRef.setImbalanceLevel(0);
      simulatorRef.setManualMode(false, 0);
      simulatorRef.finishAutoCollection();
    } catch (_) {}
  }

  return { stopped: true };
}

function isRunning() {
  return running;
}

function getStatus() {
  return { ...runStatus, running };
}

module.exports = { start, startQuick, stop, isRunning, getStatus };
