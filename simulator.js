/**
 * simulator.js - HydroSync Industrial SCADA Physics, ESG & Safety Engine
 * 
 * Compliant with:
 * - IEC 61508 Functional Safety
 * - ISO 10816 Mechanical Vibration Standards
 * - UN SDG 6.4 & ESG Water Use Efficiency (WUE) Metrics
 * - DSP High-Frequency Time-Series Vibration Buffer for Python FFT
 */

// --- Physical Constants & Tuning ---
const DT = 1.0; // 1-second simulation step
const AMBIENT_TEMP = 24.0; // °C baseline
const TANK_RECHARGE_RATE = 0.4; // Baseline L/s natural replenishment
const PUMP_MAX_FLOW = 25.0; // L/min at 100% PWM
const WATER_PRICE_PER_LITER = 0.045; // $ per liter
const DZD_PER_USD = 134.5; // DZD exchange rate
const KWH_PER_PUMPED_LITER = 0.00045; // Pumping energy at 3.5 bar
const KG_CO2_PER_KWH = 0.52; // Grid carbon emission intensity

// DSP Sampling Parameters for AI FFT Diagnostics
const WAVEFORM_SAMPLES = 256;
const SAMPLING_RATE_HZ = 1000;

// Rolling Audit Buffer for Industrial CSV Export
const AUDIT_BUFFER_MAX = 150;
const auditHistory = [];

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
  et0: 4.2,

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
  pumpDuty: 0.0,
  effectivePwm: 0.0,
  motorTemp: 24.0,
  isManual: false,
  manualPwm: 0.0,

  // ⚙️ Predictive Maintenance & Asset Health (ISO 10816 + DSP Waveform)
  assetHealth: {
    healthIndex: 98.4,
    vibrationRms: 0.22,
    vibrationIsoZone: 'ZONE_A',
    cavitationIndex: 2.1,
    bearingWearPct: 4.8,
    operatingHoursTotal: 1420.4,
    rulHours: 6580,
    recommendedAction: 'NOMINAL_OPERATION',
    rationale: 'Vibration velocity and acoustic signature within ISO 10816 Zone A nominal limits.',
    // حقول الـ DSP المضافة للـ AI والرسوم البيانية
    vibrationWaveform: new Array(WAVEFORM_SAMPLES).fill(0),
    dominantFrequencyHz: 0.0,
    samplingRateHz: SAMPLING_RATE_HZ,
    bufferSize: WAVEFORM_SAMPLES
  },

  // 📊 ESG & SDG 6.4 Water Use Efficiency Accounting
  esgMetrics: {
    efficiencyScorePct: 93.8, // SDG 6.4 Efficiency %
    energySavedKwh: 64.1,
    co2OffsetKg: 33.3,
    totalSavedDzd: 19166.25,
    totalSavedUsd: 142.5
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

  // Multi-Zone Micro-Plots with Cumulative Water Accounting
  activeZoneId: 'A1',
  zones: [
    { id: 'A1', crop: 'Wheat', moisture: 48.0, setpoint: 48.0, absorptionRate: 1.0, waterUsedL: 284.5 },
    { id: 'A2', crop: 'Tomatoes', moisture: 64.0, setpoint: 65.0, absorptionRate: 1.4, waterUsedL: 412.0 },
    { id: 'A3', crop: 'Olives', moisture: 35.0, setpoint: 35.0, absorptionRate: 0.6, waterUsedL: 146.0 },
    { id: 'B1', crop: 'Barley', moisture: 41.0, setpoint: 42.0, absorptionRate: 0.9, waterUsedL: 210.5 },
    { id: 'B2', crop: 'Corn', moisture: 59.0, setpoint: 60.0, absorptionRate: 1.3, waterUsedL: 388.0 },
    { id: 'B3', crop: 'Potatoes', moisture: 54.0, setpoint: 55.0, absorptionRate: 1.1, waterUsedL: 330.0 }
  ],

  // 🛡️ Safety & Interlocks
  systemHealth: 'NOMINAL',
  interlocks: {
    dryRun: false,
    thermalTrip: false,
    pipeBurst: false,
    floodRisk: false,
    sensorFault: false
  },
  activeFaults: [],
  burstPipeCounter: 0
};

let activeDisturbance = null;
let disturbanceDuration = 0;

/* ==========================================================================
 *  DSP TIME-SERIES VIBRATION SYNTHESIZER (ISO 10816 + FFT HARMONICS)
 * ========================================================================== */

function generateVibrationWaveform(targetRms, isRunning, pwm, bearingWear, cavitation) {
  if (!isRunning || targetRms < 0.05) {
    // ضوضاء الحساس الأساسية في حالة توقف المضخة (Noise Floor)
    const idleSamples = new Array(WAVEFORM_SAMPLES);
    for (let i = 0; i < WAVEFORM_SAMPLES; i++) {
      idleSamples[i] = Number(((Math.random() - 0.5) * 0.06).toFixed(3));
    }
    return { samples: idleSamples, dominantFreq: 0.0 };
  }

  // التردد الدوراني الأساسي للمحرك (1X RPM) بين 45Hz و 55Hz بناءً على سرعة الضخ
  const f0 = 45.0 + (pwm / 100.0) * 10.0;
  const dt = 1.0 / SAMPLING_RATE_HZ;

  // تردد عيوب المحامل (BPFO ~ 3.56 * f0)
  const fBearing = f0 * 3.56;
  const bearingSeverity = bearingWear / 100.0;

  // معامل التكهف الهيدروليكي
  const cavitationFactor = Math.max(0, (cavitation - 10.0) / 90.0);

  let sumSquares = 0.0;
  const rawSignal = new Float64Array(WAVEFORM_SAMPLES);

  for (let n = 0; n < WAVEFORM_SAMPLES; n++) {
    const t = n * dt;

    // 1. التردد الأساسي الأول (1X Fundamental Harmonic)
    let s = Math.sin(2 * Math.PI * f0 * t);

    // 2. التوافقية الثانية (2X Dynamic Misalignment Harmonic)
    s += 0.35 * Math.sin(2 * Math.PI * (2 * f0) * t + 0.4);

    // 3. نبضات تآكل المحامل (Amplitude Modulated Bearing Defect Pulses)
    if (bearingSeverity > 0.04) {
      const impact = Math.sin(2 * Math.PI * fBearing * t);
      s += (bearingSeverity * 2.2) * impact * (1.0 + 0.5 * Math.sin(2 * Math.PI * f0 * t));
    }

    // 4. ضوضاء التكهف الهيدروليكي العشوائية واسعة النطاق
    if (cavitationFactor > 0.0) {
      s += (cavitationFactor * 2.5) * (Math.random() - 0.5);
    }

    // 5. تداخل عشوائي طبيعي للحساس (Sensor Gaussian Noise)
    s += 0.12 * (Math.random() - 0.5);

    rawSignal[n] = s;
    sumSquares += s * s;
  }

  // مطابقة طاقة الإشارة المحسوبة رياضياً مع الـ RMS الحقيقي لـ ISO 10816
  const currentRms = Math.sqrt(sumSquares / WAVEFORM_SAMPLES) || 1.0;
  const scale = targetRms / currentRms;

  const finalSamples = new Array(WAVEFORM_SAMPLES);
  for (let n = 0; n < WAVEFORM_SAMPLES; n++) {
    finalSamples[n] = Number((rawSignal[n] * scale).toFixed(3));
  }

  return {
    samples: finalSamples,
    dominantFreq: Number(f0.toFixed(1))
  };
}

/* ==========================================================================
 *  CORE PHYSICS & SAFETY ROUTINES
 * ========================================================================== */

function applySlewRate(targetPwm) {
  const MAX_SLEW = 12.0;
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

function updateReservoirCavitation() {
  state.tankVolumePct = (state.tankVolumeL / state.tankCapacityL) * 100.0;

  if (state.tankVolumePct <= 5.0 && !state.interlocks.dryRun) {
    state.interlocks.dryRun = true;
  } else if (state.tankVolumePct >= 15.0 && state.interlocks.dryRun) {
    state.interlocks.dryRun = false;
  }
}

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

function checkAntiFlooding() {
  if (state.vwc >= 88.0) {
    state.interlocks.floodRisk = true;
  } else if (state.vwc <= 80.0) {
    state.interlocks.floodRisk = false;
  }
}

function updatePredictiveMaintenanceModel() {
  const ah = state.assetHealth;
  const dutyFraction = state.effectivePwm / 100.0;
  const isRunning = state.effectivePwm > 1.0;

  if (isRunning) {
    ah.operatingHoursTotal += (1.0 / 3600.0);
  }

  let cavitationStress = 0.0;
  if (state.tankVolumePct < 25.0 && state.effectivePwm > 35.0) {
    const depthDeficit = (25.0 - state.tankVolumePct) / 25.0;
    cavitationStress = (depthDeficit * (state.effectivePwm / 100.0)) * 75.0;
  }
  ah.cavitationIndex = Math.max(1.0, Math.min(99.0, 2.0 + cavitationStress + (Math.random() * 1.5)));

  let baseVib = 0.18 + (Math.random() * 0.08);
  if (isRunning) {
    baseVib += (dutyFraction * 1.45);
    if (state.motorTemp > 75.0) {
      baseVib += ((state.motorTemp - 75.0) / 10.0) * 0.85;
    }
    if (cavitationStress > 10.0) {
      baseVib += (cavitationStress / 75.0) * 3.8;
    }
  }
  ah.vibrationRms = Number(baseVib.toFixed(2));

  if (ah.vibrationRms < 1.8) ah.vibrationIsoZone = 'ZONE_A';
  else if (ah.vibrationRms < 2.8) ah.vibrationIsoZone = 'ZONE_B';
  else if (ah.vibrationRms < 4.5) ah.vibrationIsoZone = 'ZONE_C';
  else ah.vibrationIsoZone = 'ZONE_D';

  if (isRunning) {
    const wearMultiplier = (ah.vibrationIsoZone === 'ZONE_D') ? 0.0008 
      : (ah.vibrationIsoZone === 'ZONE_C') ? 0.0003 
      : 0.00005;
    ah.bearingWearPct = Math.min(100.0, ah.bearingWearPct + wearMultiplier);
  }

  const wearPenaltyHours = (ah.bearingWearPct / 100.0) * 6000.0;
  const cavitationPenaltyHours = (ah.cavitationIndex > 40.0) ? 650.0 : 0.0;
  ah.rulHours = Math.max(40, Math.round(8000.0 - ah.operatingHoursTotal - wearPenaltyHours - cavitationPenaltyHours));

  const healthDeductions = (ah.bearingWearPct * 0.4) 
    + ((ah.vibrationRms / 4.5) * 18.0) 
    + ((ah.cavitationIndex / 100.0) * 15.0) 
    + (state.motorTemp > 80.0 ? 12.0 : 0.0);

  ah.healthIndex = Math.max(12.0, Math.min(100.0, Number((100.0 - healthDeductions).toFixed(1))));

  // توليد مصفوفة الموجة الزمنية الخام للـ FFT
  const dspWave = generateVibrationWaveform(
    ah.vibrationRms,
    isRunning,
    state.effectivePwm,
    ah.bearingWearPct,
    ah.cavitationIndex
  );
  ah.vibrationWaveform = dspWave.samples;
  ah.dominantFrequencyHz = dspWave.dominantFreq;

  if (ah.vibrationIsoZone === 'ZONE_D' || ah.cavitationIndex > 65.0) {
    ah.recommendedAction = 'IMMEDIATE_INSPECTION_REQUIRED';
    ah.rationale = `Critical hydrodynamic shock detected (Vib: ${ah.vibrationRms} mm/s, Cavitation: ${ah.cavitationIndex.toFixed(0)}%). High risk of impeller erosion.`;
  } else if (ah.vibrationIsoZone === 'ZONE_C' || state.motorTemp > 80.0) {
    ah.recommendedAction = 'SCHEDULE_BEARING_MAINTENANCE';
    ah.rationale = `Elevated thermal/vibrational fatigue (Zone C, ${ah.vibrationRms} mm/s). Mechanical lubrication and bearing clearance check recommended.`;
  } else {
    ah.recommendedAction = 'NOMINAL_OPERATION';
    ah.rationale = `Hydraulic impeller, winding thermals (${state.motorTemp.toFixed(1)}°C), and acoustic signature within optimal baseline.`;
  }
}

/* ==========================================================================
 *  MAIN SIMULATION LOOP
 * ========================================================================== */
function pidLoop() {
  const waterConsumedL = (state.flowRate / 60.0) * DT;
  state.tankVolumeL = Math.max(0, state.tankVolumeL - waterConsumedL + (TANK_RECHARGE_RATE * DT));
  state.tankVolumeL = Math.min(state.tankCapacityL, state.tankVolumeL);
  updateReservoirCavitation();

  const activePlot = state.zones.find(z => z.id === state.activeZoneId);
  if (activePlot && waterConsumedL > 0) {
    activePlot.waterUsedL = Number((activePlot.waterUsedL + waterConsumedL).toFixed(2));
  }

  updateMotorThermalModel();
  checkAntiFlooding();

  let rawPwmCommand = 0.0;
  if (state.isManual) {
    rawPwmCommand = state.manualPwm;
  } else {
    state.error = state.setpoint - state.vwc;
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

  // Interlock overrides
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

  if (state.interlocks.dryRun || state.interlocks.pipeBurst || state.interlocks.floodRisk) {
    state.systemHealth = 'EMERGENCY_LOCK';
  } else if (state.interlocks.thermalTrip) {
    state.systemHealth = 'DEGRADED';
  } else {
    state.systemHealth = 'NOMINAL';
  }

  state.pumpDuty = rawPwmCommand;
  const safePwm = applySlewRate(rawPwmCommand);
  state.flowRate = (safePwm / 100.0) * PUMP_MAX_FLOW;

  updatePredictiveMaintenanceModel();

  // Agronomic Drainage & Weather dynamics
  let soilDrainRate = 0.35;
  if (state.soilType === 'sandy') soilDrainRate = 0.65;
  if (state.soilType === 'clay') soilDrainRate = 0.18;

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

  const evapLoss = (state.et0 / 24.0) * 0.08;
  const irrigationInflow = (state.flowRate * 0.08);
  const deltaVwc = (irrigationInflow - soilDrainRate - evapLoss + disturbanceEffect) * DT;

  checkHydraulicIntegrity(deltaVwc);
  state.vwc = Math.max(5.0, Math.min(99.0, state.vwc + deltaVwc));
  state.filteredVwc = (0.85 * state.filteredVwc) + (0.15 * state.vwc);

  state.zones.forEach(z => {
    if (z.id === state.activeZoneId) {
      z.moisture = state.vwc;
    } else {
      z.moisture = Math.max(10.0, z.moisture - (0.05 + evapLoss * 0.5));
    }
  });

  // ESG & SDG 6.4 Accounting
  const baselineConsumption = 18.0;
  const savedThisSec = Math.max(0, (baselineConsumption - state.flowRate) / 60.0);
  state.waterSavedL += savedThisSec;
  state.waterSaved = Math.max(10, Math.min(92, ((baselineConsumption - state.flowRate) / baselineConsumption) * 100));

  const totalSavedUSD = state.waterSavedL * WATER_PRICE_PER_LITER;
  const energyKwh = state.waterSavedL * KWH_PER_PUMPED_LITER;
  state.esgMetrics = {
    efficiencyScorePct: Number(state.waterSaved.toFixed(1)),
    energySavedKwh: Number(energyKwh.toFixed(2)),
    co2OffsetKg: Number((energyKwh * KG_CO2_PER_KWH).toFixed(2)),
    totalSavedDzd: Number((totalSavedUSD * DZD_PER_USD).toFixed(2)),
    totalSavedUsd: Number(totalSavedUSD.toFixed(2))
  };

  auditHistory.push({
    time: new Date().toISOString(),
    zone: state.activeZoneId,
    vwc: state.vwc.toFixed(1),
    target: state.setpoint.toFixed(1),
    pumpDuty: state.effectivePwm.toFixed(1),
    flowRate: state.flowRate.toFixed(1),
    motorTemp: state.motorTemp.toFixed(1),
    vibrationRms: state.assetHealth.vibrationRms.toFixed(2),
    healthIndex: state.assetHealth.healthIndex.toFixed(1),
    faults: state.activeFaults.length ? state.activeFaults.join(';') : 'NOMINAL'
  });
  if (auditHistory.length > AUDIT_BUFFER_MAX) auditHistory.shift();
}

/* ==========================================================================
 *  PUBLIC API
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
    // إتاحة مصفوفة الاهتزاز في المستوى العام للتيسير على عبد الحق وسيرين
    vibrationWaveform: state.assetHealth.vibrationWaveform,
    assetHealth: {
      ...state.assetHealth,
      healthIndex: Number(state.assetHealth.healthIndex.toFixed(1)),
      vibrationRms: Number(state.assetHealth.vibrationRms.toFixed(2)),
      cavitationIndex: Number(state.assetHealth.cavitationIndex.toFixed(1)),
      bearingWearPct: Number(state.assetHealth.bearingWearPct.toFixed(2)),
      operatingHoursTotal: Number(state.assetHealth.operatingHoursTotal.toFixed(1)),
      rulHours: Math.round(state.assetHealth.rulHours),
      vibrationWaveform: state.assetHealth.vibrationWaveform,
      dominantFrequencyHz: state.assetHealth.dominantFrequencyHz,
      samplingRateHz: SAMPLING_RATE_HZ,
      bufferSize: WAVEFORM_SAMPLES
    },
    esgMetrics: state.esgMetrics
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

function servicePumpAsset() {
  state.assetHealth.bearingWearPct = 0.5;
  state.assetHealth.cavitationIndex = 1.0;
  state.assetHealth.healthIndex = 99.5;
  state.assetHealth.rulHours = 8000;
  state.assetHealth.recommendedAction = 'NOMINAL_OPERATION';
  state.assetHealth.rationale = 'Preventive service logged. Rotor bearings recalibrated and fatigue reset.';
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

function getAuditHistory() {
  return auditHistory;
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
  servicePumpAsset,
  getAuditHistory
};