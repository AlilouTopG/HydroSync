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

// --- === System Constants === ---
const EVA_RATE = 0.2;          // Evaporation rate %/sec
const PUMP_EFFICIENCY = 0.015; // VWC increase per % pump duty %/sec
const FLOW_RATE_MULT = 0.05;   // L/min per % pump duty
const ANTI_WINDUP_CLAMP = 100; // Integral accumulation clamp

// --- === System State === ---
let state = {
  vwc: 35.0,           // Current VWC (%)
  setpoint: 55.0,      // Target VWC (%)
  temp: 24.0,          // Root-zone temperature (°C)
  kp: 2.0,             // Proportional gain
  ki: 0.1,             // Integral gain
  kd: 0.5,             // Derivative gain
  pumpDuty: 0,         // Actuator PWM Duty Cycle (0-100%)
  flowRate: 0,         // Hydraulic flow (L/min)
  waterSaved: 0,       // Cumulative % saved vs open-loop
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
  const now = Date.now();
  const dt = (now - lastPidTime) / 1000; // time in seconds
  lastPidTime = now;

  if (dt <= 0) return;

  // 1. Physical soil dynamics
  // VWC naturally decreases by evaporation
  state.vwc = Math.max(0, state.vwc - EVA_RATE * dt);

  // If not in manual mode, PID controls the pump
  if (!isManual) {
    // Compute error
    state.error = state.setpoint - state.vwc;

    // Integral term with anti-windup clamp
    integral += state.error * dt;
    integral = Math.max(-ANTI_WINDUP_CLAMP, Math.min(ANTI_WINDUP_CLAMP, integral));

    // Derivative term
    const derivative = (state.error - state.lastError) / dt;

    // PID output
    const rawOutput = (state.kp * state.error) + (state.ki * integral) + (state.kd * derivative);

    // Clamp pump duty to 0-100%
    state.pumpDuty = Math.max(0, Math.min(100, rawOutput));
  } else {
    // Manual mode: use manualPwm
    state.pumpDuty = Math.max(0, Math.min(100, manualPwm));
  }

  // 2. Physical soil dynamics: pump increases VWC
  // pumpDuty * 0.015%/sec increase in VWC
  const vwcIncrease = state.pumpDuty * PUMP_EFFICIENCY;
  state.vwc = Math.min(100, state.vwc + vwcIncrease);

  // 3. Update derived values
  state.flowRate = state.pumpDuty * FLOW_RATE_MULT; // L/min

  // 4. Update temperature with slight noise (±0.5°C)
  state.temp = Math.max(18, Math.min(30, 24.0 + (Math.random() - 0.5)));

  // 5. Water conservation efficiency (cumulative)
  // Compare current vwc trajectory vs. if pump were off (open-loop)
  // Simple heuristic: waterSaved increases when pump is active and vwc approaches setpoint
  if (state.pumpDuty > 0 && state.error !== 0) {
    // Gradual efficiency accumulation when actively controlling
    state.waterSaved = Math.min(100, state.waterSaved + 0.001 * dt);
  }

  // 6. Schedule next loop iteration (1-second interval)
  setTimeout(pidLoop, 1000 - ((Date.now() - now) % 1000));
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
    // Spike VWC to 80% (heavy rain)
    state.vwc = 80.0;
  }
  // Recompute PID terms after disturbance
  computePidTerms();
}

/* ==========================================
 *  HANDLER: Set manual mode with PWM output
 *  ========================================== */
function setManualMode(enabled, manualPwm) {
  isManual = enabled !== undefined ? enabled : false;
  if (manualPwm !== undefined) {
    manualPwm = Math.max(0, Math.min(100, manualPwm));
    manualPwm = manualPwm;
  }
  // When switching to manual, set the PWM output
  if (isManual) {
    state.pumpDuty = manualPwm;
  }
  // When switching back to auto, PID loop will take over
  computePidTerms();
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
  injectDisturbance,
  setManualMode,
  pidLoop // expose for server-controlled timing if needed
};