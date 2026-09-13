/**
 * simulator.js - HydroSync Industrial SCADA Physics & Safety Engine
 * 
 * Implements IEC 61508 / SIL-inspired Industrial Protection Layers & ISO 10816 Predictive Maintenance:
 * 1. Cavitation & Dry-Run Interlock with Hysteresis (5% Cutoff, 15% Release)
 * 2. Water Hammer Soft Ramp (Slew-Rate Limiter <= 12%/s)
 * 3. Pump Motor Thermal Modeling & Duty Derating (Trip at 85°C)
 * 4. Hydraulic Burst & Major Leakage Detection
 * 5. Root Asphyxiation / Anti-Flooding Interlock (>88% VWC Cutoff)
 * 6. Sensor Health & Low-Pass Telemetry Filtering
 * 7. Real-Time Satellite Weather Ingestion & Dynamic ET0 Dynamics
 * 8. Predictive Maintenance Core: ISO 10816 Vibration RMS, Cavitation Index, RUL & Health Index
 */

// --- Physical Constants & Tuning ---
const DT = 1.0; // 1-second simulation step
const AMBIENT_TEMP = 24.0; // °C baseline
const TANK_RECHARGE_RATE = 0.4; // Baseline L/s natural replenishment
const PUMP_MAX_FLOW = 25.0; // L/min at 100% PWM
const WATER_PRICE_PER_LITER = 0.045; // $ per liter

// --- Simulation State ---
let state = {
  // Agronomic Telemetry
  vwc: 48.0, // Active Soil Moisture %
  filteredVwc: 48.0,
  setpoint: 55.0,
  soilType: 'loam',
  tankCapacityL: 200,
  tankVolumeL: 170.0,
  tankVolumePct: 85.0,
  flowRate: 0.0,
  waterSaved: 68.0,
  waterSavedL: 142.5,
  ambientTemp: 24.0,
  et0: 4.2, // Evapotranspiration mm/day

  // 🛰️ Live Satellite Weather Twin
  liveWeather: {
    location: 'Sétif (High Plains - Cereal)',
    temp: 24.0,
    humidity: 50,
    rain: 0.0,
    windSpeed: 8.0,
    weatherCode: 0,
    et0: 4.2
  },

  // Actuator & Motor Physics
  pumpDuty: 0.0,        // Commanded PWM %
  effectivePwm: 0.0,    // Post-Slew-Rate PWM %
  motorTemp: 24.0,      // Motor Coil Temperature °C
  isManual: false,
  manualPwm: 0.0,

  // ⚙️ PREDICTIVE MAINTENANCE & ASSET HEALTH (ISO 10816 Standards)
  assetHealth: {
    healthIndex: 98.4,            // Overall Health Score % (100% down to 0%)
    vibrationRms: 0.22,           // Mechanical Vibration Velocity (mm/s RMS)
    vibrationIsoZone: 'ZONE_A',   // ISO 10816 Zone: A (Good), B (Acceptable), C (Warning), D (Critical)
    cavitationIndex: 2.1,         // Hydrodynamic Cavitation Strain %
    bearingWearPct: 4.8,          // Mechanical Bearing & Bushing Degradation %
    operatingHoursTotal: 1420.4,  // Total Lifetime Cumulative Run Hours
    rulHours: 6580,               // Remaining Useful Life (Operating Hours before overhaul)
    recommendedAction: 'NOMINAL_OPERATION',
    rationale: 'Vibration velocity and acoustic cavitation signature within ISO 10816 Zone A nominal limits.'
  },

  // PID Internal Variables
  kp: 2.2,
  ki: 0.08,
  kd: 0.4,
  pTerm: 0.0,
  iTerm: 0.0,
  dTerm: 0.0,
  error: 0.0,
  lastError: 0.0,
  integralAcc: 0.0,

  // Multi-Zone Micro-Plots Heatmap
  activeZoneId: 'A1',
  zones: [
    { id: 'A1', crop: 'Wheat', moisture: 48.0, setpoint: 48.0, absorptionRate: 1.0 },
    { id: 'A2', crop: 'Tomatoes', moisture: 64.0, setpoint: 65.0, absorptionRate: 1.4 },
    { id: 'A3', crop: 'Olives', moisture: 35.0, setpoint: 35.0, absorptionRate: 0.6 },
    { id: 'B1', crop: 'Barley', moisture: 41.0, setpoint: 42.0, absorptionRate: 0.9 },
    { id: 'B2', crop: 'Corn', moisture: 59.0, setpoint: 60.0, absorptionRate: 1.3 },
    { id: 'B3', crop: 'Potatoes', moisture: 54.0, setpoint: 55.0, absorptionRate: 1.1 }
  ],

  // 🛡️ INDUSTRIAL SAFETY & INTERLOCK MATRIX
  systemHealth: 'NOMINAL', // 'NOMINAL' | 'DEGRADED' | 'EMERGENCY_LOCK'
  interlocks: {
    dryRun: false,       // Reservoir Cavitation Lock (< 5%)
    thermalTrip: false,  // Motor Coil Overheat (> 85°C)
    pipeBurst: false,    // Hydraulic Burst / Runaway Flow
    floodRisk: false,    // Soil Saturation Lock (> 88%)
    sensorFault: false   // Signal Loss / Out of Bounds
  },
  activeFaults: [],
  burstPipeCounter: 0
};

// Disturbance state
let activeDisturbance = null; // 'drought' | 'rain' | null
let disturbanceDuration = 0;

/* ==========================================================================
 *  CORE SAFETY & PREDICTIVE MAINTENANCE SUB-ROUTINES
 * ========================================================================== */

/**
 * 1. Water Hammer Slew-Rate Limiter (Soft Ramp)
 */
function applySlewRate(targetPwm) {
  const MAX_SLEW = 12.0; // Maximum PWM % change per second
  const delta = targetPwm - state.effectivePwm;

  if (Math.abs(delta) <= MAX_SLEW) {
    state.effectivePwm = targetPwm;
  } else if (delta > 0) {
    state.effectivePwm += MAX_SLEW;
  } else {
    state.effectivePwm -= MAX_SLEW;
  }

  state.effectivePwm = Math.max(0.0, Math.min(100.0, state.effectivePwm));
  return state.effectivePwm;
}

/**
 * 2. Motor Thermal Physics Model
 */
function updateMotorThermalModel() {
  const dutyFraction = state.effectivePwm / 100.0;
  const heatGen = (dutyFraction * dutyFraction) * 2.2; 
  const heatDissipation = 0.08 * (state.motorTemp - state.ambientTemp);

  state.motorTemp += (heatGen - heatDissipation) * DT;
  state.motorTemp = Math.max(state.ambientTemp, state.motorTemp);

  if (state.motorTemp >= 85.0 && !state.interlocks.thermalTrip) {
    state.interlocks.thermalTrip = true;
  } else if (state.motorTemp <= 60.0 && state.interlocks.thermalTrip) {
    state.interlocks.thermalTrip = false;
  }
}

/**
 * 3. Reservoir Cavitation & Dry-Run Protection (Hysteresis)
 */
function updateReservoirCavitation() {
  state.tankVolumePct = (state.tankVolumeL / state.tankCapacityL) * 100.0;

  if (state.tankVolumePct <= 5.0 && !state.interlocks.dryRun) {
    state.interlocks.dryRun = true;
  } else if (state.tankVolumePct >= 15.0 && state.interlocks.dryRun) {
    state.interlocks.dryRun = false;
  }
}

/**
 * 4. Hydraulic Burst & Major Leakage Detection
 */
function checkHydraulicIntegrity(deltaVwc) {
  if (state.effectivePwm > 70.0 && state.flowRate > 12.0 && deltaVwc <= 0.05) {
    state.burstPipeCounter++;
    if (state.burstPipeCounter >= 12) {
      state.interlocks.pipeBurst = true;
    }
  } else {
    state.burstPipeCounter = Math.max(0, state.burstPipeCounter - 1);
  }
}

/**
 * 5. Anti-Flooding & Root Asphyxiation Interlock
 */
function checkAntiFlooding() {
  if (state.vwc >= 88.0) {
    state.interlocks.floodRisk = true;
  } else if (state.vwc <= 80.0) {
    state.interlocks.floodRisk = false;
  }
}

/**
 * 6. Predictive Maintenance & ISO 10816 Asset Health Model
 * Synthesizes vibration dynamics, hydraulic cavitation strain, and operating degradation.
 */
function updatePredictiveMaintenanceModel() {
  const ah = state.assetHealth;
  const dutyFraction = state.effectivePwm / 100.0;
  const isRunning = state.effectivePwm > 1.0;

  // Increment lifetime operating hours during active pumping
  if (isRunning) {
    ah.operatingHoursTotal += (1.0 / 3600.0); // 1 sec in hours
  }

  // Calculate Hydrodynamic Cavitation Strain (Suction depression under low tank volume + high duty)
  let cavitationStress = 0.0;
  if (state.tankVolumePct < 25.0 && state.effectivePwm > 35.0) {
    const depthDeficit = (25.0 - state.tankVolumePct) / 25.0; // 0 to 1
    cavitationStress = (depthDeficit * (state.effectivePwm / 100.0)) * 75.0;
  }
  ah.cavitationIndex = Math.max(1.0, Math.min(99.0, 2.0 + cavitationStress + (Math.random() * 1.5)));

  // Calculate Mechanical Vibration (ISO 10816 Class I/II RMS mm/s)
  let baseVib = 0.18 + (Math.random() * 0.08); // Baseline ambient noise
  if (isRunning) {
    baseVib += (dutyFraction * 1.45); // Operational rotor velocity
    
    // Thermal bearing distortion penalty (> 75°C)
    if (state.motorTemp > 75.0) {
      baseVib += ((state.motorTemp - 75.0) / 10.0) * 0.85;
    }
    
    // Cavitation turbulence shock waves
    if (cavitationStress > 10.0) {
      baseVib += (cavitationStress / 75.0) * 3.8;
    }
  }
  ah.vibrationRms = Number(baseVib.toFixed(2));

  // Determine ISO 10816 Severity Zone
  if (ah.vibrationRms < 1.8) {
    ah.vibrationIsoZone = 'ZONE_A'; // Good
  } else if (ah.vibrationRms < 2.8) {
    ah.vibrationIsoZone = 'ZONE_B'; // Acceptable
  } else if (ah.vibrationRms < 4.5) {
    ah.vibrationIsoZone = 'ZONE_C'; // Warning / Degradation
  } else {
    ah.vibrationIsoZone = 'ZONE_D'; // Critical / Structural Trip Risk
  }

  // Micro-wear accumulation
  if (isRunning) {
    const wearMultiplier = (ah.vibrationIsoZone === 'ZONE_D') ? 0.0008 
      : (ah.vibrationIsoZone === 'ZONE_C') ? 0.0003 
      : 0.00005;
    ah.bearingWearPct = Math.min(100.0, ah.bearingWearPct + wearMultiplier);
  }

  // Remaining Useful Life (RUL in operating hours, rated from 8000h baseline)
  const wearPenaltyHours = (ah.bearingWearPct / 100.0) * 6000.0;
  const cavitationPenaltyHours = (ah.cavitationIndex > 40.0) ? 650.0 : 0.0;
  ah.rulHours = Math.max(40, Math.round(8000.0 - ah.operatingHoursTotal - wearPenaltyHours - cavitationPenaltyHours));

  // Overall Asset Health Index % (100% -> 0%)
  const healthDeductions = (ah.bearingWearPct * 0.4) 
    + ((ah.vibrationRms / 4.5) * 18.0) 
    + ((ah.cavitationIndex / 100.0) * 15.0)
    + (state.motorTemp > 80.0 ? 12.0 : 0.0);

  ah.healthIndex = Math.max(12.0, Math.min(100.0, Number((100.0 - healthDeductions).toFixed(1))));

  // Predictive Action Recommendation & Diagnostics Rationale
  if (ah.vibrationIsoZone === 'ZONE_D' || ah.cavitationIndex > 65.0) {
    ah.recommendedAction = 'IMMEDIATE_INSPECTION_REQUIRED';
    ah.rationale = `Critical hydrodynamic shock detected (Vib: ${ah.vibrationRms} mm/s, Cavitation: ${ah.cavitationIndex.toFixed(0)}%). High risk of impeller erosion. Throttle duty.`;
  } else if (ah.vibrationIsoZone === 'ZONE_C' || state.motorTemp > 80.0) {
    ah.recommendedAction = 'SCHEDULE_BEARING_MAINTENANCE';
    ah.rationale = `Elevated thermal/vibrational fatigue (Zone C, ${ah.vibrationRms} mm/s). Mechanical lubrication and bearing clearance check recommended within 120 operating hours.`;
  } else {
    ah.recommendedAction = 'NOMINAL_OPERATION';
    ah.rationale = `Hydraulic impeller, winding thermals (${state.motorTemp.toFixed(1)}°C), and acoustic signature are within optimal operating baseline.`;
  }
}

/* ==========================================================================
 *  MAIN PID & PHYSICAL SIMULATION STEP
 * ========================================================================== */
function pidLoop() {
  // Update Reservoir Levels
  const waterConsumedL = (state.flowRate / 60.0) * DT;
  state.tankVolumeL = Math.max(0, state.tankVolumeL - waterConsumedL + (TANK_RECHARGE_RATE * DT));
  state.tankVolumeL = Math.min(state.tankCapacityL, state.tankVolumeL);
  updateReservoirCavitation();

  // Run Motor Thermal Dynamics
  updateMotorThermalModel();

  // Check Root Saturation
  checkAntiFlooding();

  // Determine Target Command (Manual or Closed-Loop PID)
  let rawPwmCommand = 0.0;

  if (state.isManual) {
    rawPwmCommand = state.manualPwm;
  } else {
    state.error = state.setpoint - state.vwc;
    
    // Anti-windup clamping on integral accumulator
    state.integralAcc += state.error * DT;
    state.integralAcc = Math.max(-25.0, Math.min(25.0, state.integralAcc));

    const derivative = (state.error - state.lastError) / DT;
    state.lastError = state.error;

    state.pTerm = state.kp * state.error;
    state.iTerm = state.ki * state.integralAcc;
    state.dTerm = state.kd * derivative;

    let computed = state.pTerm + state.iTerm + state.dTerm;
    rawPwmCommand = Math.max(0.0, Math.min(100.0, computed));
  }

  // --- 🛡️ APPLY INDUSTRIAL INTERLOCK ENFORCEMENT ---
  state.activeFaults = [];

  if (state.interlocks.dryRun) {
    rawPwmCommand = 0.0;
    state.activeFaults.push('LOCK: RESERVOIR CAVITATION PREVENTED (LEVEL < 5%)');
  }
  if (state.interlocks.pipeBurst) {
    rawPwmCommand = 0.0;
    state.activeFaults.push('LOCK: MAJOR HYDRAULIC PIPE RUPTURE DETECTED');
  }
  if (state.interlocks.floodRisk) {
    rawPwmCommand = 0.0;
    state.activeFaults.push('LOCK: ANTI-FLOODING / ROOT ASPHYXIATION OVERRIDE');
  }
  if (state.interlocks.thermalTrip) {
    rawPwmCommand = Math.min(rawPwmCommand, 30.0);
    state.activeFaults.push('THROTTLE: MOTOR COIL THERMAL DERATING ACTIVE (TEMP > 85°C)');
  }

  // Determine Overall System Health
  if (state.interlocks.dryRun || state.interlocks.pipeBurst || state.interlocks.floodRisk) {
    state.systemHealth = 'EMERGENCY_LOCK';
  } else if (state.interlocks.thermalTrip) {
    state.systemHealth = 'DEGRADED';
  } else {
    state.systemHealth = 'NOMINAL';
  }

  // Apply Slew-Rate Limiter (Soft Ramp)
  state.pumpDuty = rawPwmCommand;
  const safePwm = applySlewRate(rawPwmCommand);

  // Compute Hydraulic Flow Rate
  state.flowRate = (safePwm / 100.0) * PUMP_MAX_FLOW;

  // Run ISO 10816 Predictive Maintenance Sub-Routine
  updatePredictiveMaintenanceModel();

  // Active Zone Soil Physics & Moisture Dynamics
  let soilDrainRate = 0.35; // Loam base drainage
  if (state.soilType === 'sandy') soilDrainRate = 0.65;
  if (state.soilType === 'clay') soilDrainRate = 0.18;

  // Environmental Disturbances vs Satellite Ambient
  let disturbanceEffect = 0.0;
  if (activeDisturbance === 'drought') {
    disturbanceEffect = -1.6;
    state.ambientTemp = 38.5;
    state.et0 = 8.2;
  } else if (activeDisturbance === 'rain') {
    disturbanceEffect = 2.4;
    state.ambientTemp = 17.0;
    state.et0 = 1.0;
    state.tankVolumeL = Math.min(state.tankCapacityL, state.tankVolumeL + 2.5);
  } else {
    state.ambientTemp = state.liveWeather ? state.liveWeather.temp : AMBIENT_TEMP;
    state.et0 = state.liveWeather ? state.liveWeather.et0 : 4.2;
  }

  if (disturbanceDuration > 0) {
    disturbanceDuration--;
    if (disturbanceDuration === 0) activeDisturbance = null;
  }

  // Moisture Delta calculation
  const evapLoss = (state.et0 / 24.0) * 0.08;
  const irrigationInflow = (state.flowRate * 0.08);
  const deltaVwc = (irrigationInflow - soilDrainRate - evapLoss + disturbanceEffect) * DT;

  // Integrity Check for Bursts
  checkHydraulicIntegrity(deltaVwc);

  // Update active zone soil moisture
  state.vwc = Math.max(5.0, Math.min(99.0, state.vwc + deltaVwc));

  // Low-Pass Sensor Filter
  state.filteredVwc = (0.85 * state.filteredVwc) + (0.15 * state.vwc);

  // Update Zones Array
  state.zones.forEach(z => {
    if (z.id === state.activeZoneId) {
      z.moisture = state.vwc;
    } else {
      z.moisture = Math.max(10.0, z.moisture - (0.05 + evapLoss * 0.5));
    }
  });

  // Financial ROI & Water Conservation Calculation
  const baselineConsumption = 18.0;
  const savedThisSec = Math.max(0, (baselineConsumption - state.flowRate) / 60.0);
  state.waterSavedL += savedThisSec;
  state.waterSaved = Math.max(10, Math.min(92, ((baselineConsumption - state.flowRate) / baselineConsumption) * 100));
}

/* ==========================================================================
 *  PUBLIC API & EVENT HANDLERS
 * ========================================================================== */

function getState() {
  return {
    ...state,
    vwc: Number(state.vwc.toFixed(1)),
    filteredVwc: Number(state.filteredVwc.toFixed(1)),
    pumpDuty: Number(state.effectivePwm.toFixed(1)),
    rawCommandDuty: Number(state.pumpDuty.toFixed(1)),
    flowRate: Number(state.flowRate.toFixed(1)),
    motorTemp: Number(state.motorTemp.toFixed(1)),
    tankVolumeL: Number(state.tankVolumeL.toFixed(1)),
    tankVolumePct: Number(state.tankVolumePct.toFixed(1)),
    waterSaved: Number(state.waterSaved.toFixed(1)),
    waterSavedL: Number(state.waterSavedL.toFixed(1)),
    financialSavingsUsd: Number((state.waterSavedL * WATER_PRICE_PER_LITER).toFixed(3)),
    error: Number(state.error.toFixed(2)),
    liveWeather: state.liveWeather,
    assetHealth: {
      ...state.assetHealth,
      healthIndex: Number(state.assetHealth.healthIndex.toFixed(1)),
      vibrationRms: Number(state.assetHealth.vibrationRms.toFixed(2)),
      cavitationIndex: Number(state.assetHealth.cavitationIndex.toFixed(1)),
      bearingWearPct: Number(state.assetHealth.bearingWearPct.toFixed(2)),
      operatingHoursTotal: Number(state.assetHealth.operatingHoursTotal.toFixed(1)),
      rulHours: Math.round(state.assetHealth.rulHours)
    }
  };
}

function setPIDParams(params) {
  if (params.kp !== undefined) state.kp = Math.max(0, Number(params.kp));
  if (params.ki !== undefined) state.ki = Math.max(0, Number(params.ki));
  if (params.kd !== undefined) state.kd = Math.max(0, Number(params.kd));
}

function setTargetSetpoint(sp) {
  state.setpoint = Math.max(0.0, Math.min(100.0, Number(sp)));
  const currentZone = state.zones.find(z => z.id === state.activeZoneId);
  if (currentZone) currentZone.setpoint = state.setpoint;
}

function setSettings(settings) {
  if (settings.setpoint !== undefined) setTargetSetpoint(settings.setpoint);
  if (settings.tankCapacity !== undefined) state.tankCapacityL = Math.max(20, Number(settings.tankCapacity));
  if (settings.soilType !== undefined) state.soilType = String(settings.soilType);
}

function injectDisturbance(type) {
  activeDisturbance = type;
  disturbanceDuration = 25;
  if (type === 'rain') {
    state.interlocks.pipeBurst = false;
    state.burstPipeCounter = 0;
  }
}

function setActiveZone(zoneId) {
  state.activeZoneId = zoneId;
  const target = state.zones.find(z => z.id === zoneId);
  if (target) {
    state.vwc = target.moisture;
    state.filteredVwc = target.moisture;
    state.setpoint = target.setpoint;
    state.integralAcc = 0;
  }
}

function setManualMode(enabled, pwm) {
  state.isManual = Boolean(enabled);
  state.manualPwm = Math.max(0.0, Math.min(100.0, Number(pwm || 0)));
}

/**
 * Service & Reset Pump Asset Health
 */
function servicePumpAsset() {
  state.assetHealth.bearingWearPct = 0.5;
  state.assetHealth.cavitationIndex = 1.0;
  state.assetHealth.healthIndex = 99.5;
  state.assetHealth.rulHours = 8000;
  state.assetHealth.recommendedAction = 'NOMINAL_OPERATION';
  state.assetHealth.rationale = 'Preventive service logged. Rotor bearings recalibrated and impeller cleared.';
}

function setLiveWeather(w) {
  if (!w) return;
  state.ambientTemp = Number(w.temp) || state.ambientTemp;
  state.et0 = Number(w.et0) || state.et0;
  state.liveWeather = {
    location: w.location || "Sétif",
    temp: Number(w.temp) || 24.0,
    humidity: Number(w.humidity) || 50,
    rain: Number(w.rain) || 0.0,
    windSpeed: Number(w.windSpeed) || 8.0,
    weatherCode: w.weatherCode !== undefined ? w.weatherCode : 0,
    et0: Number(w.et0) || 4.2
  };

  if (w.rain > 0) {
    state.tankVolumeL = Math.min(state.tankCapacityL, state.tankVolumeL + (w.rain * 1.5));
    state.vwc = Math.min(95.0, state.vwc + (w.rain * 0.8));
  }
}

module.exports = {
  getState,
  pidLoop,
  setPIDParams,
  setTargetSetpoint,
  setSettings,
  injectDisturbance,
  setActiveZone,
  setManualMode,
  setLiveWeather,
  servicePumpAsset
};