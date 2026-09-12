/**
 * simulator.js - HydroSync Soil Moisture VWC + PID Controller Simulator
 * 
 * Refactored for full-stack synchronization with server.js and public/app.js.
 * 
 * System State:
 *   vwc: Volumetric Water Content (%) - 0-100% range
 *   setpoint: Target VWC (%)
 *   temp: Root-Zone Temperature (°C) with slight noise
 *   kp, ki, kd: PID gains
 *   pumpDuty: Actuator Output / PWM Duty Cycle (0-100%)
 *   flowRate: Hydraulic flow (L/min) = pumpDuty * 0.05
 *   waterSaved: Cumulative % saved vs open-loop timer
 *   error, pTerm, iTerm, dTerm: Diagnostic breakdowns
 *   systemStartTime: Timestamp for uptime calculation
 * 
 * PID Loop: Runs every 1000ms (1-second interval)
 * Physical Dynamics: VWC evaporates naturally (-0.2%/sec), 
 *                    pump increases VWC proportionally to pumpDuty.
 */

// --- === System Constants (real-world ag-tech physics) === ---
const EVA_BASE = 0.12;         // Baseline evaporation %/sec (scaled by ET0 below)
const ANTI_WINDUP_CLAMP = 100; // Integral accumulation clamp
// Hydraulic orifice (valve): Q = Cd * A * sqrt(2*P/rho), D = 9 mm, P = 200 kPa
const ORIFICE_CD = 0.61;
const ORIFICE_D = 0.009;       // m
const ORIFICE_A = Math.PI / 4 * ORIFICE_D * ORIFICE_D; // m^2
const LINE_PRESSURE = 200000;  // Pa
const WATER_RHO = 1000;        // kg/m^3
const Q_FULL_LMIN = ORIFICE_CD * ORIFICE_A * Math.sqrt(2 * LINE_PRESSURE / WATER_RHO) * 60000; // ≈46.6 L/min
const FLOOD_BASELINE_LMIN = 6; // Standard flood-irrigation baseline flow
// Soil physics: absorption (VWC gain per %PWM/sec) + decay multiplier
const SOILS = {
  sandy: { absorption: 0.010, decay: 1.4 },
  loam:  { absorption: 0.015, decay: 1.0 },
  clay:  { absorption: 0.022, decay: 0.6 }
};

// --- === System State === ---
let state = {
  vwc: 35.0,           // Current VWC (%)
  setpoint: 55.0,      // Target VWC (%)
  temp: 24.0,          // Root-zone temperature (°C)
  kp: 2.0,             // Proportional gain
  ki: 0.1,             // Integral gain
  kd: 0.5,             // Derivative gain
  pumpDuty: 0,         // Actuator PWM Duty Cycle (0-100%)
  flowRate: 0,         // Hydraulic flow (L/min, orifice formula)
  waterSaved: 0,       // Cumulative % saved vs flood baseline
  waterSavedL: 0,      // Accumulated real liters saved vs flood baseline
  waterUsedL: 0,       // Accumulated real liters dispensed
  floodUsedL: 0,       // Accumulated flood-baseline liters
  et0: 0,              // Reference evapotranspiration (mm/day, Hargreaves approx)
  solarRad: 20,        // Simulated solar radiation (MJ/m2/day)
  tankCapacityL: 200,  // Reservoir capacity (L, configurable)
  tankVolumeL: 170,    // Current reservoir volume (L)
  soilType: 'loam',    // sandy | loam | clay
  error: 0,            // e(t) = setpoint - vwc
  pTerm: 0,            // Proportional term
  iTerm: 0,            // Integral term
  dTerm: 0,            // Derivative term
  lastError: 0,        // Previous error for derivative
  systemStartTime: Date.now()
};

// --- === PID Loop State === ---
let integral = 0;
let lastPidTime = 0;
let isManual = false;
let manualPwm = 0;

/**
 * Initialize/reset the simulator state to defaults.
 */
function init() {
  state = {
    vwc: 35.0,
    setpoint: 55.0,
    temp: 24.0,
    kp: 2.0,
    ki: 0.1,
    kd: 0.5,
    pumpDuty: 0,
    flowRate: 0,
    waterSaved: 0,
    waterSavedL: 0,
    waterUsedL: 0,
    floodUsedL: 0,
    et0: 0,
    solarRad: 20,
    tankCapacityL: 200,
    tankVolumeL: 170,
    soilType: 'loam',
    error: 0,
    pTerm: 0,
    iTerm: 0,
    dTerm: 0,
    lastError: 0,
    systemStartTime: Date.now()
  };
  integral = 0;
  lastPidTime = 0;
  isManual = false;
  manualPwm = 0;
}

/* ==========================================
 *  GETTER: Return current simulator state
 *  ========================================== */
function getState() {
  // Recalculate error and terms before returning
  computePidTerms();
  return {
    vwc: state.vwc,
    setpoint: state.setpoint,
    temp: state.temp,
    kp: state.kp,
    ki: state.ki,
    kd: state.kd,
    pumpDuty: state.pumpDuty,
    flowRate: state.flowRate,
    waterSaved: state.waterSaved,
    waterSavedL: state.waterSavedL,
    waterUsedL: state.waterUsedL,
    floodUsedL: state.floodUsedL,
    et0: state.et0,
    solarRad: state.solarRad,
    tankCapacityL: state.tankCapacityL,
    tankVolumeL: state.tankVolumeL,
    soilType: state.soilType,
    isManual,
    error: state.error,
    pTerm: state.pTerm,
    iTerm: state.iTerm,
    dTerm: state.dTerm,
    uptimeSeconds: Math.floor((Date.now() - state.systemStartTime) / 1000)
  };
}

/* ==========================================
 *  PID CONTROL LOOP (runs every 1000ms)
 *  ========================================== */
function pidLoop() {
  // NOTE: driven by server.js every 1000ms — no self-scheduling (avoids double-stepping).
  const now = Date.now();
  let dt = (now - lastPidTime) / 1000; // time in seconds
  if (!(dt > 0) || dt > 5) dt = 1;
  lastPidTime = now;

  const soil = SOILS[state.soilType] || SOILS.loam;

  // 1. Solar + temperature model (diurnal wave + noise), then ET0 (Hargreaves approx):
  // ET0 = 0.0023 * (T + 17.8) * sqrt(TR) * (Rs / 2.45), TR ≈ 6 °C diurnal range.
  const dayFrac = (now / 86400000) % 1;
  state.solarRad = Math.max(2, 18 + 10 * Math.sin(dayFrac * Math.PI * 2) + (Math.random() - 0.5) * 2);
  state.temp = Math.max(18, Math.min(32, 24 + (state.solarRad - 18) * 0.25 + (Math.random() - 0.5) * 0.4));
  state.et0 = 0.0023 * (state.temp + 17.8) * Math.sqrt(6) * (state.solarRad / 2.45);

  // 2. Evapotranspiration-driven VWC decay, scaled by soil type
  const evaRate = (EVA_BASE + state.et0 * 0.04) * soil.decay;
  state.vwc = Math.max(0, state.vwc - evaRate * dt);

  // 3. PID control (auto) or manual PWM
  if (!isManual) {
    state.error = state.setpoint - state.vwc;
    integral += state.error * dt;
    integral = Math.max(-ANTI_WINDUP_CLAMP, Math.min(ANTI_WINDUP_CLAMP, integral));
    const derivative = (state.error - state.lastError) / dt;
    const rawOutput = (state.kp * state.error) + (state.ki * integral) + (state.kd * derivative);
    state.pumpDuty = Math.max(0, Math.min(100, rawOutput));
  } else {
    state.pumpDuty = Math.max(0, Math.min(100, manualPwm));
  }

  // 4. Cavitation guard: empty tank cannot pump
  if (state.tankVolumeL <= 0) state.pumpDuty = 0;

  // 5. Soil absorption: pump increases VWC per soil type
  state.vwc = Math.min(100, state.vwc + state.pumpDuty * soil.absorption * dt);

  // 6. Hydraulic orifice flow: Q = Cd * A * sqrt(2P/rho) * (PWM/100)
  state.flowRate = Q_FULL_LMIN * (state.pumpDuty / 100);

  // 7. Reservoir + real-liter accounting vs flood-irrigation baseline
  const usedStep = (state.flowRate / 60) * dt;
  const floodStep = (FLOOD_BASELINE_LMIN / 60) * dt;
  state.waterUsedL += usedStep;
  state.floodUsedL += floodStep;
  state.tankVolumeL = Math.max(0, Math.min(state.tankCapacityL, state.tankVolumeL - usedStep + 0.03 * dt));
  state.waterSavedL = Math.max(0, state.floodUsedL - state.waterUsedL);
  state.waterSaved = state.floodUsedL > 0
    ? Math.max(0, Math.min(100, (state.waterSavedL / state.floodUsedL) * 100))
    : 0;
}

/* ==========================================
 *  HANDLER: Set PID parameters
 *  ========================================== */
function setPIDParams({ kp, ki, kd }) {
  if (typeof kp === 'number') state.kp = kp;
  if (typeof ki === 'number') state.ki = ki;
  if (typeof kd === 'number') state.kd = kd;
}

/* ==========================================
 *  HANDLER: Set target setpoint
 *  ========================================== */
function setTargetSetpoint(sp) {
  state.setpoint = Math.max(0, Math.min(100, sp));
}

/* ==========================================
 *  HANDLER: Inject disturbance (drought/rain)
 *  ========================================== */
function injectDisturbance(type) {
  if (type === 'drought') {
    // Drop VWC to 10% (severe drought)
    state.vwc = 10.0;
    // Keep other state variables intact
  } else if (type === 'rain') {
    // Spike VWC to 80% (heavy rain) + storm refill of the reservoir
    state.vwc = 80.0;
    state.tankVolumeL = Math.min(state.tankCapacityL, state.tankVolumeL + state.tankCapacityL * 0.25);
  }
  // Recompute PID terms after disturbance
  computePidTerms();
}

/* ==========================================
 *  HANDLER: Set manual mode with PWM output
 *  ========================================== */
function setManualMode(enabled, pwm) {
  isManual = enabled !== undefined ? enabled : false;
  if (pwm !== undefined) {
    manualPwm = Math.max(0, Math.min(100, pwm));
  }
  // When switching to manual, set the PWM output
  if (isManual) {
    state.pumpDuty = manualPwm;
  }
  // When switching back to auto, PID loop will take over
  computePidTerms();
}

/* ==========================================
 *  HANDLER: Physical system settings (from Settings modal)
 *  ========================================== */
function setSettings({ setpoint, tankCapacityL, soilType }) {
  if (typeof setpoint === 'number') setTargetSetpoint(setpoint);
  if (typeof tankCapacityL === 'number' && tankCapacityL > 0) {
    const ratio = state.tankVolumeL / state.tankCapacityL;
    state.tankCapacityL = Math.min(2000, Math.max(20, tankCapacityL));
    state.tankVolumeL = Math.max(0, Math.min(state.tankCapacityL, state.tankCapacityL * ratio));
  }
  if (typeof soilType === 'string' && SOILS[soilType]) state.soilType = soilType;
}

/* ==========================================
 *  INTERNAL: Compute PID terms for diagnostics
 *  ========================================== */
function computePidTerms() {
  state.error = state.setpoint - state.vwc;

  // Proportional term
  state.pTerm = state.kp * state.error;

  // Integral term (snapshot of current integral accumulator)
  state.iTerm = integral;

  // Derivative term (based on error change)
  state.dTerm = state.kd * ((state.error - state.lastError) / 0.1 || 0); // 0.1s approximation

  // Store last error for next derivative calculation
  state.lastError = state.error;
}

/* ==========================================
 *  EXPORT MODULE
 *  ========================================== */
module.exports = {
  init,
  getState,
  setPIDParams,
  setTargetSetpoint,
  setSettings,
  injectDisturbance,
  setManualMode,
  pidLoop // driven by server.js every 1000ms
};