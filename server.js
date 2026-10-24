require('dotenv').config();
﻿/**

 * server.js - HydroSync SCADA Server (Hardened Production Release)

 * Architecture: Node.js Telemetry Ingestion + Safety Interlocks + AI MPC Bridge

 * Security Hardening: Anti-SSRF, Strict CORS, CSP, Timing-Safe Auth, Rate-Limiter

 * Features: Live Weather, GIS Fleet Map, 24h AI MPC, Asset Health & CSV Audit Endpoint

 */



const express = require('express');

const demoMode = require('./database/demoMode');

const app = express();

app.use(express.json());



const http = require('http');

const path = require('path');

const crypto = require('crypto');

const { Server } = require('socket.io');

const simulator = require('./simulator');
const { analyzeWaveform } = require('./database/vibrationAnalysis');
const { createMlPredictionStore } = require('./ai_agent/mlPredictionStore');
const { createTestLabStore, SCENARIOS } = require('./ai_agent/testLabStore');
const { createTestLabWorkflow } = require('./ai_agent/testLabWorkflow');


const telemetryCollector = require('./database/telemetryCollector');
const { parseAutoCollectOptions, runAutoCollection } = require('./database/autoCollector');
const autoCollectOptions = parseAutoCollectOptions(process.argv.slice(2));
const {
  addCaptureMetadata,
  createDiagnosticsResponse,
  createDiagnosticsSnapshot,
  createVibrationSnapshotStore
} = require('./ai_agent/vibrationSnapshot');



const DEBUG = false;


// استدعاء نواة التحكم وصمامات الأمان الخاصة بك

const { evaluateSafety, calculateIrrigationDuty, resetSafetyState } = require('./core_control/mpc_controller');




const server = http.createServer(app);



// Trust proxy for correct client IP extraction behind reverse proxies

app.set('trust proxy', 1);

app.disable('x-powered-by');



// 1. Security Headers & Content Security Policy (CSP)

app.use((req, res, next) => {

  res.setHeader('X-Content-Type-Options', 'nosniff');

  res.setHeader('X-Frame-Options', 'DENY');

  res.setHeader('X-XSS-Protection', '1; mode=block');

  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  res.setHeader(

    'Content-Security-Policy',

    "default-src 'self'; " +

    "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://cdn.socket.io https://cdnjs.cloudflare.com; " +

    "style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://fonts.googleapis.com; " +

    "font-src 'self' https://cdnjs.cloudflare.com https://fonts.gstatic.com; " +

    "connect-src 'self' wss: https: http:; " +

    "img-src 'self' data: https: https://server.arcgisonline.com https://*.basemaps.cartocdn.com https://*.tile.openstreetmap.org;"

  );

  next();

});



// 2. CSV Industrial Audit Export Route

app.get('/api/export-audit.csv', (req, res) => {

  const history = simulator.getAuditHistory();

  res.setHeader('Content-Type', 'text/csv');

  res.setHeader('Content-Disposition', 'attachment; filename="hydrosync-scada-audit.csv"');



  let csvContent = 'Timestamp,ActiveZone,VWC_Pct,Setpoint_Pct,PumpDuty_Pct,FlowRate_Lmin,MotorTemp_C,Vibration_RMS_mms,HealthIndex_Pct,Status_Faults\r\n';

  history.forEach(row => {

    csvContent += `"${row.time}","${row.zone}",${row.vwc},${row.target},${row.pumpDuty},${row.flowRate},${row.motorTemp},${row.vibrationRms},${row.healthIndex},"${row.faults}"\r\n`;

  });



  res.send(csvContent);

});



// 3. Python AI Engine Bridge Endpoint

const AI_ENGINE_URL = process.env.AI_ENGINE_URL || 'http://127.0.0.1:8000';

const AI_REQUEST_TIMEOUT_MS = 4000;

const AI_FRESHNESS_MS = 4000;



const vibrationSnapshotStore = createVibrationSnapshotStore();

let pythonBridgeOfflineLogged = false;



function cachePythonVibration(data) {
  return vibrationSnapshotStore.update(data);
}


// ─── ML Prediction Bridge ─────────────────────────────────────────────────
// Calls the AI engine's /predict endpoint with the current 9 features.
// Runs asynchronously after the telemetry insert — never blocks the pump loop.
// Only fires when the pump is at steady state within the training PWM range
// (40–80), matching the ISO 10816 convention of measuring at steady state.
const mlPredictionStore = createMlPredictionStore();
let pwmHistory = [];
let activeDemoState = null;

async function callPrediction(state, demoState, vibrationFeatures) {
  if (demoState && demoState.phase !== 'measurement') return null;

  const pwm_actual = Number(state.pumpDuty);

  // track last 5 PWM samples
  pwmHistory.push(pwm_actual);
  if (pwmHistory.length > 5) pwmHistory.shift();

  // guard 1: PWM must be within the training range
  if (!Number.isFinite(pwm_actual) || pwm_actual < 40 || pwm_actual > 80) return null;

  // guard 2: PWM must be stable across the last 5 samples
  if (pwmHistory.length < 5) return null;
  const pwmStable = (Math.max(...pwmHistory) - Math.min(...pwmHistory)) < 2;
  if (!pwmStable) return null;

  const feats = vibrationFeatures || vibrationSnapshotStore.get().features || {};
  const vibration_rms = Number(feats.vibration_rms ?? state.assetHealth?.vibrationRms);
  const dominant_frequency_hz = Number(feats.dominant_frequency_hz ?? state.assetHealth?.dominantFrequencyHz);
  const one_x_amplitude = Number(feats.one_x_amplitude);
  const two_x_amplitude = Number(feats.two_x_amplitude);
  const two_x_to_one_x_ratio = Number(feats.two_x_to_one_x_ratio);
  const spectral_energy = Number(feats.spectral_energy);
  const motor_temp_c = Number(state.motorTemp);
  const pwm_target = Number(state.rawCommandDuty);

  const values = [vibration_rms, dominant_frequency_hz, one_x_amplitude,
                  two_x_amplitude, two_x_to_one_x_ratio, spectral_energy,
                  motor_temp_c, pwm_actual, pwm_target];
  if (values.some(v => !Number.isFinite(v))) return null;

  try {
    const res = await fetch(`${AI_ENGINE_URL}/predict`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        vibration_rms,
        dominant_frequency_hz,
        one_x_amplitude,
        two_x_amplitude,
        two_x_to_one_x_ratio,
        spectral_energy,
        motor_temp_c,
        pwm_actual,
        pwm_target
      }),
      signal: AbortSignal.timeout(1500)
    });
    if (!res.ok) throw new Error(`AI engine status: ${res.status}`);
    return await res.json();
  } catch (e) {
    console.warn('[ML] predict failed:', e.message);
    return null;
  }
}

app.get('/api/ai/diagnostics', async (req, res) => {

  try {

    const [diagRes, vibRes] = await Promise.all([

      fetch(`${AI_ENGINE_URL}/diagnostics`, { signal: AbortSignal.timeout(AI_REQUEST_TIMEOUT_MS) }),

      fetch(`${AI_ENGINE_URL}/vibration/latest`, { signal: AbortSignal.timeout(AI_REQUEST_TIMEOUT_MS) }).catch(() => null)

    ]);

    if (!diagRes.ok) throw new Error(`AI Engine status: ${diagRes.status}`);

    const diagnostics = await diagRes.json();

    if (vibRes && vibRes.ok) {
      cachePythonVibration(await vibRes.json());

    }

    const vibration = vibrationSnapshotStore.get();
    res.json(createDiagnosticsResponse(vibration, {
      status: 'ONLINE',
      engine: 'Python-FastAPI',
      diagnosticsMessage: diagnostics && diagnostics.message,
      includeVibration: true
    }));

  } catch (err) {

    const vibration = vibrationSnapshotStore.get();
    res.json(createDiagnosticsResponse(vibration, {
      status: 'FALLBACK',
      engine: 'Node-ISO10816-Baseline',
      message: 'Python AI Engine in ai_engine/ is currently offline. Operating on local safety interlocks.'
    }));

  }

});



app.get('/api/ai/vibration', async (req, res) => {

  try {

    const response = await fetch(`${AI_ENGINE_URL}/vibration/latest`, { signal: AbortSignal.timeout(AI_REQUEST_TIMEOUT_MS) });

    if (!response.ok) throw new Error(`AI Engine status: ${response.status}`);

    const data = await response.json();

    const vibration = cachePythonVibration(data);

    res.json({

      status: 'ONLINE',

      engine: 'Python-FastAPI',

      waveform: vibration.waveform,

      fft: vibration.fft,

      features: vibration.features

    });

  } catch (err) {

    res.json({

      status: 'FALLBACK',

      engine: 'Node-ISO10816-Baseline',

      waveform: null,

      fft: vibrationSnapshotStore.get().fft,
      features: vibrationSnapshotStore.get().features,

    });

  }

});



app.get('/api/ai/vibration/multi-axis', async (req, res) => {

  try {

    const response = await fetch(`${AI_ENGINE_URL}/vibration/latest`, { signal: AbortSignal.timeout(AI_REQUEST_TIMEOUT_MS) });

    if (!response.ok) throw new Error(`AI Engine status: ${response.status}`);

    const data = await response.json();

    const vibration = cachePythonVibration(data);

    res.json({

      status: 'ONLINE',

      engine: 'Python-FastAPI',

      multi_axis: vibration.multi_axis,

      waveform: vibration.waveform,

      fft: vibration.fft,

      features: vibration.features

    });

  } catch (err) {

    res.json({

      status: 'FALLBACK',

      engine: 'Node-ISO10816-Baseline',

      multi_axis: vibrationSnapshotStore.get().multi_axis,

      waveform: null,

      fft: vibrationSnapshotStore.get().fft,
      features: vibrationSnapshotStore.get().features,

      msg: 'Python AI Engine is currently offline.'

    });

  }

});



// 4. تحميل الملفات الساكنة

app.use(express.static(path.join(__dirname, 'public'), { dotfiles: 'ignore', index: ['index.html'] }));



const isProduction = process.env.NODE_ENV === 'production';

const ALLOWED_ORIGINS = new Set((process.env.ALLOWED_ORIGINS || 'https://hydrosync-0khc.onrender.com').split(',').map(s => s.trim()).filter(Boolean));

const LOCALHOST_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;



const originOk = (o) => !o || (!isProduction && LOCALHOST_RE.test(o)) || ALLOWED_ORIGINS.has(o);



const io = new Server(server, {

  cors: {

    origin: (o, cb) => originOk(o) ? cb(null, true) : cb(new Error('Blocked by SCADA CORS Policy'), false),

    methods: ['GET', 'POST']

  },

  allowRequest: (req, cb) => cb(null, originOk(req.headers.origin))

});



let serverStartTime = Date.now();

const OPERATOR_PIN_HASH = process.env.OPERATOR_PIN

  ? crypto.createHash('sha256').update(process.env.OPERATOR_PIN).digest()

  : (process.env.NODE_ENV === 'production'

      ? (() => { throw new Error('OPERATOR_PIN must be set in production'); })()

      : crypto.createHash('sha256').update('8492').digest()

    );



// إدارة حالات الأمان والقفل الصناعي

let isSafetyTripped = false;

let activeSafetyReason = '';



const AUTH_BUDGET = { fails: 0, resetAt: 0 };

const authBudgetOk = () => {

  const t = Date.now();

  if (t > AUTH_BUDGET.resetAt) { AUTH_BUDGET.fails = 0; AUTH_BUDGET.resetAt = t + 60000; }

  return AUTH_BUDGET.fails < 60;

};



const clientFirewallState = new Map();

const failedAttemptsByIp = new Map();

let totalThreatsBlocked = 0;



function safeCompare(submittedPin) {

  const submittedHash = crypto.createHash('sha256').update(String(submittedPin)).digest();

  return crypto.timingSafeEqual(submittedHash, OPERATOR_PIN_HASH);

}



function firewallValidate(socket, cost = 1) {

  const now = Date.now();

  let client = clientFirewallState.get(socket.id);

  if (!client) {

    client = { tokens: 10, lastRefill: now, authorized: false };

    clientFirewallState.set(socket.id, client);

  }

  const elapsed = (now - client.lastRefill) / 1000;

  client.tokens = Math.min(10, client.tokens + elapsed * 3);

  client.lastRefill = now;

  if (client.tokens < cost) {

    totalThreatsBlocked++;

    socket.emit('firewall:alert', { type: 'RATE_LIMIT_EXCEEDED', msg: 'Command rate limit exceeded. Action dropped.' });

    return false;

  }

  client.tokens -= cost;

  return true;

}



function verifyOperatorAuth(socket) {

  const client = clientFirewallState.get(socket.id);

  if (!client || !client.authorized) {

    totalThreatsBlocked++;

    socket.emit('firewall:alert', { type: 'UNAUTHORIZED_ACCESS', msg: 'Access Denied: Action requires authenticated Operator credentials.' });

    return false;

  }

  return true;

}



const LOCATION_COORDINATES = Object.freeze({

  'setif': Object.freeze({ lat: 36.19, lon: 5.41, name: 'Sétif (High Plains - Cereal)' }),

  'biskra': Object.freeze({ lat: 34.85, lon: 5.73, name: 'Biskra (Oasis - Palms/Greenhouse)' }),

  'eloued': Object.freeze({ lat: 33.37, lon: 6.86, name: 'El Oued (Desert Basin - Tubers)' }),

  'mitidja': Object.freeze({ lat: 36.56, lon: 2.91, name: 'Mitidja (Coastal Plains - Citrus)' })

});



let activeLocationKey = 'setif';

let latestAIPrediction = {

  horizon: [],

  rainHoldActive: false,

  maxRainProb12h: 0,

  confidence: 94,

  recommendation: 'NOMINAL_MONITORING',

  waterSavedEstimateL: 0,

  rationale: 'Atmospheric conditions stable. Standard PID moisture control engaged.'

};



async function fetchSatelliteWeather(key = 'setif') {

  try {

    if (!Object.prototype.hasOwnProperty.call(LOCATION_COORDINATES, key)) key = 'setif';

    const loc = LOCATION_COORDINATES[key];

    activeLocationKey = key;

    const url = new URL('https://api.open-meteo.com/v1/forecast');

    url.searchParams.set('latitude', loc.lat.toString());

    url.searchParams.set('longitude', loc.lon.toString());

    url.searchParams.set('current', 'temperature_2m,relative_humidity_2m,precipitation,wind_speed_10m,weather_code');

    url.searchParams.set('hourly', 'precipitation_probability,precipitation,temperature_2m,wind_speed_10m');

    url.searchParams.set('daily', 'et0_fao_evapotranspiration');

    url.searchParams.set('forecast_days', '2');

    url.searchParams.set('timezone', 'auto');



    const response = await fetch(url.toString(), { signal: AbortSignal.timeout(6000) });

    if (!response.ok) throw new Error(`Open-Meteo HTTP ${response.status}`);



    const data = await response.json();

    const cur = data.current || {};

    const daily = data.daily || {};

    const hourly = data.hourly || {};



    const liveData = {

      location: loc.name,

      temp: typeof cur.temperature_2m === 'number' ? cur.temperature_2m : 24.0,

      humidity: typeof cur.relative_humidity_2m === 'number' ? cur.relative_humidity_2m : 50,

      rain: typeof cur.precipitation === 'number' ? cur.precipitation : 0.0,

      windSpeed: typeof cur.wind_speed_10m === 'number' ? cur.wind_speed_10m : 8.0,

      weatherCode: typeof cur.weather_code === 'number' ? cur.weather_code : 0,

      et0: (Array.isArray(daily.et0_fao_evapotranspiration) && daily.et0_fao_evapotranspiration.length > 0) ? Number(daily.et0_fao_evapotranspiration[0]) : 4.2

    };



    simulator.setLiveWeather(liveData);



    if (hourly.time && Array.isArray(hourly.time)) {

      const currentHourStr = cur.time ? cur.time.substring(0, 13) : '';

      let startIndex = hourly.time.findIndex(t => t.startsWith(currentHourStr));

      if (startIndex < 0) startIndex = 0;



      const horizon24 = [];

      let maxRainProb12h = 0;

      let totalRain24h = 0;



      for (let i = 0; i < 24; i++) {

        const idx = startIndex + i;

        if (idx < hourly.time.length) {

          const timeLabel = hourly.time[idx].split('T')[1] || `${i}:00`;

          const prob = hourly.precipitation_probability ? Number(hourly.precipitation_probability[idx]) || 0 : 0;

          const rainMm = hourly.precipitation ? Number(hourly.precipitation[idx]) || 0 : 0;

          const temp = hourly.temperature_2m ? Number(hourly.temperature_2m[idx]) || 20 : 20;

          if (i <= 12 && prob > maxRainProb12h) maxRainProb12h = prob;

          totalRain24h += rainMm;

          horizon24.push({ hour: timeLabel, prob, rainMm, temp });

        }

      }



      const willRainSoon = maxRainProb12h >= 60 || totalRain24h >= 4.0;

      const expectedSaving = willRainSoon ? Math.round(1800 + totalRain24h * 450) : 0;

      latestAIPrediction = {

        horizon: horizon24,

        rainHoldActive: willRainSoon,

        maxRainProb12h,

        totalRain24h: Number(totalRain24h.toFixed(1)),

        confidence: willRainSoon ? Math.min(98, 80 + Math.round(maxRainProb12h * 0.2)) : 92,

        recommendation: willRainSoon ? 'AUTONOMOUS_RAIN_HOLD' : 'NOMINAL_IRRIGATION',

        waterSavedEstimateL: expectedSaving,

        rationale: willRainSoon ? `Precipitation front detected (Peak: ${maxRainProb12h}%, Cumul: ${totalRain24h.toFixed(1)}mm). Pump dispatch postponed to leverage natural precipitation.` : `Clear atmospheric outlook across next 24h. Soil moisture depletion will follow standard PID setpoint.`

      };

      simulator.setRainHold(willRainSoon);

    }

  } catch (err) {

    console.warn(`⚠️ Weather API fallback: ${err.message}`);

  }

}



fetchSatelliteWeather('setif');

setInterval(() => fetchSatelliteWeather(activeLocationKey), 10 * 60 * 1000);



// 5. إدارة جلسات الـ WebSockets

io.on('connection', (socket) => {

  const xff = (socket.handshake.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);

  const clientIp = xff.pop() || socket.handshake.address || 'unknown';

  clientFirewallState.set(socket.id, { tokens: 10, lastRefill: Date.now(), authorized: false });



  const initialState = simulator.getState();

  const initialSafety = { systemStatus: isSafetyTripped ? 'CRITICAL' : 'NORMAL', alarms: isSafetyTripped ? [activeSafetyReason] : [], tripped: isSafetyTripped };

  const initialAi = aiEngineStatus();



  socket.emit('telemetry', {

    ...initialState,

    threatsBlocked: totalThreatsBlocked,

    predictiveAI: latestAIPrediction,

    mlPrediction: mlPredictionStore.get(),
    mlPredictionStatus: mlPredictionStore.getStatus(),

    safety: initialSafety,

    fft: initialAi.online ? vibrationSnapshotStore.get().fft : null,

    aiEngine: initialAi

  });



  socket.on('client:auth', (submittedPin) => {

    if (!firewallValidate(socket, 1)) return;

    if (!authBudgetOk()) { socket.emit('auth:failed', { msg: 'Console temporarily locked.' }); return; }

    const lockData = failedAttemptsByIp.get(clientIp) || { count: 0, lockedUntil: 0 };

    const now = Date.now();

    if (lockData.lockedUntil > now) {

      const waitSecs = Math.ceil((lockData.lockedUntil - now) / 1000);

      socket.emit('auth:failed', { msg: `Console locked due to multiple failed attempts. Wait ${waitSecs}s.` });

      return;

    }

    if (typeof submittedPin === 'string' && safeCompare(submittedPin.trim())) {

      failedAttemptsByIp.delete(clientIp);

      const client = clientFirewallState.get(socket.id);

      if (client) client.authorized = true;

      socket.emit('auth:success', { authorized: true });

    } else {

      totalThreatsBlocked++;

      lockData.count++;
      AUTH_BUDGET.fails++;

      if (lockData.count >= 5) lockData.lockedUntil = now + 2 * 60 * 1000;

      failedAttemptsByIp.set(clientIp, lockData);

      socket.emit('auth:failed', { msg: 'Invalid Operator Passcode.' });

    }

  });



  // مسار إعادة الضبط الصناعي وفك القفل (Operator Trip Reset)

  socket.on('client:operator_reset', () => {

    if (!firewallValidate(socket, 2) || !verifyOperatorAuth(socket)) return;

    isSafetyTripped = false;

    activeSafetyReason = '';

    resetSafetyState();

    simulator.setManualMode(false, 0);

    console.log('✅ [SCADA TRIP RESET]: Operator cleared the safety lock.');

    broadcastTelemetry();

  });



  socket.on('client:emergency_stop', () => {

    if (isSafetyTripped) return;

    isSafetyTripped = true;

    activeSafetyReason = 'OPERATOR EMERGENCY STOP';

    simulator.setManualMode(true, 0);

    broadcastTelemetry();

  });



  socket.on('client:inject_fault', (type) => {

    if (!firewallValidate(socket, 2) || !verifyOperatorAuth(socket)) return;

    if (['bearing', 'overheat', 'clear'].includes(type)) {

      simulator.injectFault(type);

      broadcastTelemetry();

    }

  });



  socket.on('client:set_imbalance', (level) => {

    if (!firewallValidate(socket, 2) || !verifyOperatorAuth(socket)) return;

    const normalizedLevel = Math.max(0, Math.min(100, Number(level)));

    simulator.setImbalanceLevel(normalizedLevel);

    broadcastTelemetry();

  });



  socket.on('client:update_pid', (params) => {

    if (!firewallValidate(socket, 2) || !verifyOperatorAuth(socket)) return;

    if (!params || typeof params !== 'object') return;

    const kp = Number(params.kp);

    const ki = Number(params.ki);

    const kd = Number(params.kd);

    if (Number.isFinite(kp) && Number.isFinite(ki) && Number.isFinite(kd)) {

      simulator.setPIDParams({ kp: Math.max(0, Math.min(10.0, kp)), ki: Math.max(0, Math.min(2.0, ki)), kd: Math.max(0, Math.min(5.0, kd)) });

      broadcastTelemetry();

    }

  });



  socket.on('client:update_setpoint', (sp) => {

    if (!firewallValidate(socket, 1)) return;

    const target = Number(sp);

    if (Number.isFinite(target)) {

      simulator.setTargetSetpoint(Math.max(10.0, Math.min(95.0, target)));

      broadcastTelemetry();

    }

  });



  socket.on('client:update_settings', (settings) => {

    if (!firewallValidate(socket, 2) || !verifyOperatorAuth(socket)) return;

    if (!settings || typeof settings !== 'object') return;

    const cleanSetpoint = Number(settings.setpoint) || 55;

    const cleanCap = Math.max(20, Math.min(5000, Number(settings.tankCapacity) || 200));

    const cleanSoil = ['sandy', 'loam', 'clay'].includes(settings.soilType) ? settings.soilType : 'loam';

    simulator.setSettings({ setpoint: cleanSetpoint, tankCapacity: cleanCap, soilType: cleanSoil });

    broadcastTelemetry();

  });



  socket.on('client:disturbance', (type) => {

    if (!firewallValidate(socket, 3)) return;

    if (type === 'drought' || type === 'rain') {

      simulator.injectDisturbance(type);

      broadcastTelemetry();

    }

  });



  socket.on('client:select_zone', (id) => {

    if (!firewallValidate(socket, 1)) return;

    if (typeof id === 'string' && /^[A-B][1-3]$/.test(id)) {

      simulator.setActiveZone(id);

      broadcastTelemetry();

    }

  });



  socket.on('client:manual_override', (data) => {

    if (!firewallValidate(socket, 2) || !verifyOperatorAuth(socket)) return;

    if (!data || typeof data !== 'object') return;

    if (isSafetyTripped) {

      socket.emit('firewall:alert', { type: 'INTERLOCK_BLOCKED', msg: 'Cannot override while system is in SAFETY_TRIP lock.' });

      return;

    }

    simulator.setManualMode(Boolean(data.enabled), Math.max(0.0, Math.min(100.0, Number(data.manualPwm) || 0)));

    broadcastTelemetry();

  });



  socket.on('client:set_location', async (locationKey) => {

    if (!firewallValidate(socket, 2)) return;

    if (typeof locationKey === 'string' && Object.prototype.hasOwnProperty.call(LOCATION_COORDINATES, locationKey)) {

      await fetchSatelliteWeather(locationKey);

      broadcastTelemetry();

    }

  });



  socket.on('client:service_asset', () => {

    if (!firewallValidate(socket, 2) || !verifyOperatorAuth(socket)) return;

    simulator.servicePumpAsset();

    broadcastTelemetry();

  });



  socket.on('disconnect', () => {

    clientFirewallState.delete(socket.id);

  });

});



// 6. بث التيليميتري الموحد وتطبيق صمامات الأمان

const TELEMETRY_INTERVAL = 1000;

let aiInFlight = false, aiLastOkAt = 0;

let dbInFlight = false;



function aiEngineStatus(now = Date.now()) {

  return { online: now - aiLastOkAt < AI_FRESHNESS_MS, ageMs: aiLastOkAt ? now - aiLastOkAt : null };

}



let safetyCheck = { tripPump: false, systemStatus: 'NORMAL', alarms: [] };

let mpcDuty = { duty: 0, mode: 'CLOSED_LOOP_ACTIVE' };



function postVibration(state) {
  const waveforms = (state.assetHealth && state.assetHealth.vibrationWaveforms) || state.vibrationWaveforms;
  const singleWaveform = (state.assetHealth && state.assetHealth.vibrationWaveform) || state.vibrationWaveform;

  if (aiInFlight) return;

  let payload = null;
  if (
    waveforms &&
    typeof waveforms === 'object' &&
    ['x', 'y', 'z'].every(axis => Array.isArray(waveforms[axis]) && waveforms[axis].length >= 32)
  ) {
    payload = {
      vibrationWaveforms: {
        x: waveforms.x,
        y: waveforms.y,
        z: waveforms.z
      },
      samplingRateHz: (state.assetHealth && state.assetHealth.samplingRateHz) || 1000,
      bufferSize: (state.assetHealth && state.assetHealth.bufferSize) || waveforms.x.length
    };
  } else if (Array.isArray(singleWaveform) && singleWaveform.length >= 32) {
    payload = {
      vibrationWaveform: singleWaveform,
      samplingRateHz: (state.assetHealth && state.assetHealth.samplingRateHz) || 1000,
      bufferSize: (state.assetHealth && state.assetHealth.bufferSize) || singleWaveform.length
    };
  } else {
    return;
  }

  payload = addCaptureMetadata(payload);
  aiInFlight = true;

  fetch(AI_ENGINE_URL + '/vibration', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(AI_REQUEST_TIMEOUT_MS),
    body: JSON.stringify(payload)
  })

  .then(r => { if (!r.ok) throw new Error(r.status); return r.json(); })

  .then(d => {

    cachePythonVibration(d);

    aiLastOkAt = Date.now();

    pythonBridgeOfflineLogged = false;

  })

  .catch((err) => {

    const reason = (err && (err.cause && err.cause.code)) || (err && err.name) || 'unknown';

    if (!pythonBridgeOfflineLogged) {

      pythonBridgeOfflineLogged = true;

      console.warn(`⚠️ Python AI Engine unreachable at ${AI_ENGINE_URL}/vibration [${reason}] — FFT charts will use local fallback until it comes online.`);

    }

  })

  .finally(() => { aiInFlight = false; });

}



async function persistTelemetry(state) {
  if (dbInFlight) return;
  dbInFlight = true;

  try {
    const demoState = demoMode.isRunning() && activeDemoState
      ? { ...activeDemoState }
      : null;
    const vibrationFeatures = demoState
      ? analyzeWaveform(
        state.vibrationWaveform,
        Number(state.samplingRateHz || state.assetHealth?.samplingRateHz)
      )
      : vibrationSnapshotStore.get().features;
    const aiData = {
      features: vibrationFeatures,
      fft: vibrationSnapshotStore.get().fft,
      multi_axis: vibrationSnapshotStore.get().multi_axis
    };

    await mlPredictionStore.update(
      callPrediction(state, demoState, vibrationFeatures)
    );
    await telemetryCollector.recordTelemetry(state, aiData, {
      mlPrediction: mlPredictionStore.get(),
      mlPredictionStatus: mlPredictionStore.getStatus(),
      demoState
    });
  } catch (err) {
    console.error(`[Historian] insert failed: ${err.message}`);
  } finally {
    dbInFlight = false;
  }
}


function tick() {

  simulator.pidLoop();

  const state = simulator.getState();

  postVibration(state);

  if (demoMode.isRunning()) {
    safetyCheck = { tripPump: false, systemStatus: 'NORMAL', alarms: [] };
  } else {
    safetyCheck = evaluateSafety({
      pumpState: Boolean(state.pumpDuty > 0 || state.rawCommandDuty > 0),
      pumpDuty: Number(state.pumpDuty) || 0,
      flowRate: Number(state.flowRate) || 0,
      motorTemp: Number(state.motorTemp) || 25,
      vibrationRms: typeof state.assetHealth?.vibrationRms === 'number'
        ? state.assetHealth.vibrationRms
        : (Number(state.vibrationRms) || 0)
    });

    if (safetyCheck.tripPump && !isSafetyTripped) {
      isSafetyTripped = true;
      activeSafetyReason = safetyCheck.alarms.join(' | ');
      simulator.setManualMode(true, 0);
      console.warn(`[SCADA SAFETY INTERLOCK TRIPPED]: ${activeSafetyReason}`);
    }
  }

  mpcDuty = calculateIrrigationDuty(Number(state.vwc) || 20, Number(state.setpoint || state.target) || 55, Number(latestAIPrediction.maxRainProb12h) || 0);

  broadcastTelemetry();

  persistTelemetry(state);

}



function broadcastTelemetry() {

  const state = simulator.getState(), now = Date.now(), ai = aiEngineStatus(now);

  const up = Math.floor((now - serverStartTime) / 1000);

  io.emit('telemetry', {

    ...state, uptimeSeconds: up, uptimeMinutes: Math.floor(up / 60), uptimeSecs: up % 60,

    threatsBlocked: totalThreatsBlocked, predictiveAI: latestAIPrediction,

    fft: ai.online ? vibrationSnapshotStore.get().fft : null,

    aiEngine: ai,

        safety: { systemStatus: isSafetyTripped ? 'CRITICAL' : safetyCheck.systemStatus, alarms: isSafetyTripped ? [activeSafetyReason] : safetyCheck.alarms, tripped: isSafetyTripped },

    autonomousMPC: mpcDuty,

    mlPrediction: mlPredictionStore.get()

  });

}

let telemetryInterval = null;

function startTelemetryInterval() {
  if (!telemetryInterval) telemetryInterval = setInterval(tick, TELEMETRY_INTERVAL);
}



const PORT = process.env.PORT || 3000;

let isShuttingDown = false;



async function gracefulShutdown() {

  if (isShuttingDown) return;

  isShuttingDown = true;

  let shutdownError = null;

  if (telemetryInterval) clearInterval(telemetryInterval);

  try {

    await telemetryCollector.endExperiment();

    await new Promise((resolve, reject) => {

      io.close((err) => err ? reject(err) : resolve());

    });

  } catch (err) {

    shutdownError = err;

  }

  server.close((err) => {

    if (err && err.code !== 'ERR_SERVER_NOT_RUNNING' && !shutdownError) shutdownError = err;

    if (shutdownError) {

      console.error(`[SHUTDOWN] Failed to shut down cleanly: ${shutdownError.message}`);

      process.exit(1);

    }

    console.log('HydroSync server shut down cleanly.');

    process.exit(0);

  });

}



process.on('SIGINT', gracefulShutdown);

process.on('SIGTERM', gracefulShutdown);



// AI Co-Pilot Smart Chat Endpoint
const { GoogleGenerativeAI } = require("@google/generative-ai");

// Lazily constructed on first use, not at module load — so a slow-to-arrive
// env var on Render never affects server boot. Memoized after first build.
let _genAI = null;
function getGenAI() {
  if (!_genAI) {
    if (!process.env.GEMINI_API_KEY) {
      throw new Error('GEMINI_API_KEY is not set');
    }
    _genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  }
  return _genAI;
}

const CHAT_MODEL = process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite-preview';
const configuredChatTimeoutMs = Number.parseInt(process.env.CHAT_TIMEOUT_MS, 10);
const CHAT_TIMEOUT_MS = Number.isSafeInteger(configuredChatTimeoutMs) && configuredChatTimeoutMs > 0
  ? configuredChatTimeoutMs
  : 75000;

// ─── HydroSync Read-Only AI Agent ────────────────────────────────────────
const { createHydroSyncTools } = require('./ai_agent/tools');
const { createHydroSyncAgent } = require('./ai_agent/agent');
const { createConversationStore } = require('./ai_agent/conversationStore');
const chatConversationStore = createConversationStore();

// Test Lab workflow state is deliberately separate from ordinary chatbot history.
const testLabStore = createTestLabStore();
const TEST_LAB_TIMEOUT_MS = 90_000;
const testLabPreconditions = (snapshot) => {
  const reasons = [];
  if (demoMode.isRunning()) reasons.push('The existing Demo Mode is active and bypasses interlocks.');
  if (isSafetyTripped) reasons.push(activeSafetyReason || 'The SCADA safety system is tripped.');
  const telemetry = snapshot?.telemetry;
  if (!telemetry) reasons.push('Current simulator telemetry is unavailable.');
  else {
    if (telemetry.safety?.tripped) reasons.push('Current safety telemetry reports a trip.');
    if (telemetry.motorTemp >= 80) reasons.push('Motor temperature is above the Test Lab normal-operation limit.');
    if (telemetry.pumpDuty < 0 || telemetry.pumpDuty > 100) reasons.push('Pump duty is outside simulator bounds.');
  }
  const sim = simulator.getState();
  if (Object.values(sim.interlocks || {}).some(Boolean)) reasons.push('A simulator interlock is active.');
  return { allowed: reasons.length === 0, reasons };
};

function getTestLabSnapshot() {
  const now = Date.now();
  const state = simulator.getState();
  const vibrationSnapshot = vibrationSnapshotStore.get();
  const currentSafety = safetyCheck || {};
  const snapshot = {
    observedAt: new Date(now).toISOString(),
    telemetry: {
      pumpDuty: Number(state.pumpDuty), flowRate: Number(state.flowRate),
      motorTemp: Number(state.motorTemp), tankVolumePct: Number(state.tankVolumePct),
      safety: { systemStatus: isSafetyTripped ? 'CRITICAL' : (currentSafety.systemStatus || 'UNKNOWN'), alarms: isSafetyTripped ? [activeSafetyReason].filter(Boolean) : (currentSafety.alarms || []), tripped: Boolean(isSafetyTripped) },
      interlocks: { ...(state.interlocks || {}) }
    },
    diagnostics: createDiagnosticsSnapshot(vibrationSnapshot, { status: 'FALLBACK', engine: 'Node-ISO10816-Baseline' }),
    prediction: mlPredictionStore.getStatus()
  };
  return snapshot;
}

const testLabWorkflow = createTestLabWorkflow({
  store: testLabStore,
  getSnapshot: async () => getTestLabSnapshot(),
  preconditions: testLabPreconditions,
  logger: console,
  executeScenario: async ({ scenarioId, parameters }) => {
    if (scenarioId !== 'normal_operation') throw Object.assign(new Error('Only the normal-operation observation scenario is supported.'), { code: 'UNSUPPORTED_SCENARIO' });
    const observations = [];
    const startedAt = Date.now();
    const durationMs = parameters.durationSeconds * 1000;
    while (Date.now() - startedAt < durationMs) {
      const current = getTestLabSnapshot();
      const ready = testLabPreconditions(current);
      const sample = { observedAt: current.observedAt, ...current.telemetry };
      observations.push(sample);
      if (!ready.allowed) {
        const err = Object.assign(new Error(`Observation stopped by safety condition: ${ready.reasons.join('; ')}`), { code: 'ABORTED' });
        err.observations = observations;
        throw err;
      }
      if (Date.now() - startedAt >= durationMs) break;
      await new Promise(resolve => setTimeout(resolve, Math.min(1000, durationMs - (Date.now() - startedAt))));
    }
    return { status: 'completed', startedAt: new Date(startedAt).toISOString(), completedAt: new Date().toISOString(), observations };
  }
});

function testLabSession(req) {
  const sessionId = req.body?.sessionId || req.query?.sessionId;
  return typeof sessionId === 'string' && chatConversationStore.getHistory(sessionId) ? sessionId : null;
}

function testLabError(res, error) {
  const status = error.code === 'APPROVAL_REQUIRED' || error.code === 'APPROVAL_INVALID' || error.code === 'APPROVAL_EXPIRED' ? 403
    : error.code === 'RUN_NOT_EDITABLE' || error.code === 'NOT_AWAITING_APPROVAL' || error.code === 'RUN_CANNOT_CANCEL' || error.code === 'ILLEGAL_TRANSITION' ? 409
      : error.code === 'UNSUPPORTED_SCENARIO' || error.code === 'INVALID_PLAN' || error.code === 'INVALID_PARAMETERS' || error.code === 'PLAN_MISMATCH' || error.code === 'PLANNER_DELEGATION_REQUIRED' || error.code === 'COORDINATOR_REJECTED' || error.code === 'PRECONDITION_FAILED' ? 400
        : error.code === 'PLANNING_TIMEOUT' ? 504
          : error.message === 'GEMINI_API_KEY is not set' ? 503
            : error.status === 404 ? 502
              : /quota|rate.?limit/i.test(error.message) || error.status === 429 ? 429 : 500;
  const errorCode = status === 503 ? 'AI_NOT_CONFIGURED' : status === 502 ? 'AI_MODEL_UNAVAILABLE' : status === 429 ? 'AI_QUOTA_UNAVAILABLE' : status === 504 ? 'AI_TIMEOUT' : (error.code || 'TEST_LAB_ERROR');
  const message = status === 503 ? 'Test Lab requires GEMINI_API_KEY to be configured on the server.'
    : status === 502 ? `Configured Test Lab model ${error.agentMetadata?.model || ''} is unavailable. Check its model ID and API access.`
      : status === 429 ? 'Gemini quota or rate limit is unavailable. Wait for quota recovery and try again.'
        : status === 504 ? 'Test Lab planning timed out. Try again with a shorter request.'
          : status >= 500 && !error.code ? 'Test Lab agent request failed. Check server configuration and model availability.' : error.message;
  return res.status(status).json({ error: errorCode, message, status: 'error', model: error.agentMetadata?.model || null });
}

app.get('/api/test-lab/agents', (_req, res) => res.json({ agents: testLabWorkflow.getAgentMetadata(), scenarios: Object.values(SCENARIOS) }));

app.post('/api/sessions', (_req, res) => {
  const sessionId = chatConversationStore.create();
  return res.status(201).json({ sessionId });
});

app.post('/api/test-lab/runs', async (req, res) => {
  console.log('[AI Test Lab] Request handler entered.');
  const startedAt = Date.now();
  const sessionId = testLabSession(req);
  const objective = req.body?.objective;
  if (!sessionId) return res.status(401).json({ error: 'INVALID_SESSION', message: 'Start or continue a HydroSync chat session before requesting a Test Lab plan.' });
  if (typeof objective !== 'string' || !objective.trim() || objective.trim().length > 300) return res.status(400).json({ error: 'INVALID_REQUEST', message: 'Provide a test objective between 1 and 300 characters.' });
  console.log('[AI Test Lab] Creating test run', { elapsedMs: Date.now() - startedAt });
  const run = testLabStore.create({ sessionId, requestedObjective: objective.trim() });
  try {
    console.log('[AI Test Lab] Reading initial snapshot', { elapsedMs: Date.now() - startedAt });
    const initial = getTestLabSnapshot();
    console.log('[AI Test Lab] Snapshot ready', { elapsedMs: Date.now() - startedAt });
    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => reject(Object.assign(new Error('Test Lab planning timed out. Try again with a shorter request.'), { code: 'PLANNING_TIMEOUT', timeoutSource: 'server-planning', timeoutMs: TEST_LAB_TIMEOUT_MS, elapsedMs: Date.now() - startedAt })), TEST_LAB_TIMEOUT_MS);
    });
    let proposal;
    try {
      proposal = await Promise.race([testLabWorkflow.coordinatePlan(run, initial), timeoutPromise]);
    } finally {
      clearTimeout(timeoutId);
    }
    testLabStore.setPlan(run.testRunId, sessionId, proposal);
    return res.status(201).json({ run: testLabStore.safe(run) });
  } catch (error) {
    run.errors.push({ message: error.message, code: error.code || 'PLANNING_ERROR', at: new Date().toISOString() });
    if (['DRAFT', 'AWAITING_APPROVAL'].includes(run.status)) testLabStore.transition(run, 'FAILED');
    console.error('[AI Test Lab] Final route failure', { name: error?.name, status: error?.status, code: error?.code, timeoutSource: error?.timeoutSource, timeoutMs: error?.timeoutMs, elapsedMs: Date.now() - startedAt, message: error?.message });
    return testLabError(res, error);
  }
});

app.get('/api/test-lab/runs', (req, res) => {
  const sessionId = testLabSession(req);
  if (!sessionId) return res.status(401).json({ error: 'INVALID_SESSION', message: 'A valid HydroSync session is required.' });
  return res.json({ runs: testLabStore.all().filter(run => run.sessionId === sessionId) });
});

app.get('/api/test-lab/runs/:id', (req, res) => {
  const sessionId = testLabSession(req);
  if (!sessionId) return res.status(401).json({ error: 'INVALID_SESSION', message: 'A valid HydroSync session is required.' });
  const run = testLabStore.owned(req.params.id, sessionId);
  return run ? res.json({ run: testLabStore.safe(run) }) : res.status(404).json({ error: 'RUN_NOT_FOUND', message: 'Test run not found for this session.' });
});

app.post('/api/test-lab/runs/:id/approve', (req, res) => {
  const sessionId = testLabSession(req);
  if (!sessionId) return res.status(401).json({ error: 'INVALID_SESSION', message: 'A valid HydroSync session is required.' });
  try {
    const run = testLabStore.approve(req.params.id, sessionId);
    return res.json({ run: testLabStore.safe(run) });
  } catch (error) { return testLabError(res, error); }
});

app.post('/api/test-lab/runs/:id/cancel', (req, res) => {
  const sessionId = testLabSession(req);
  if (!sessionId) return res.status(401).json({ error: 'INVALID_SESSION', message: 'A valid HydroSync session is required.' });
  try { return res.json({ run: testLabStore.safe(testLabStore.cancel(req.params.id, sessionId)) }); }
  catch (error) { return testLabError(res, error); }
});

app.post('/api/test-lab/runs/:id/execute', async (req, res) => {
  const sessionId = testLabSession(req);
  if (!sessionId) return res.status(401).json({ error: 'INVALID_SESSION', message: 'A valid HydroSync session is required.' });
  const run = testLabStore.owned(req.params.id, sessionId);
  if (!run) return res.status(404).json({ error: 'RUN_NOT_FOUND', message: 'Test run not found for this session.' });
  try {
    const outcome = await testLabWorkflow.execute(run, sessionId, testLabStore);
    return res.json({ run: testLabStore.safe(outcome) });
  } catch (error) {
    if (Array.isArray(error.observations)) run.observations.push(...error.observations);
    if (['RUNNING', 'EVALUATING'].includes(run.status)) {
      run.errors.push({ message: error.message, code: error.code || 'EXECUTION_ERROR', at: new Date().toISOString() });
      run.executionCompletedAt = new Date().toISOString();
      testLabStore.transition(run, error.code === 'ABORTED' ? 'ABORTED' : 'FAILED');
    }
    return testLabError(res, error);
  }
});

let hydroSyncAgentInstance = null;

function getHydroSyncAgent() {
  if (hydroSyncAgentInstance) {
    return hydroSyncAgentInstance;
  }

  const toolset = createHydroSyncTools({
    getSnapshot: async () => {
      // Read the latest server-side values on every tool invocation.
      const now = Date.now();
      const state = simulator.getState();
      const ai = aiEngineStatus(now);
      const vibrationSnapshot = vibrationSnapshotStore.get();
      const currentSafety = safetyCheck || {};

      const alarms = isSafetyTripped
        ? (activeSafetyReason ? [activeSafetyReason] : [])
        : (Array.isArray(currentSafety.alarms)
            ? currentSafety.alarms
            : []);

      return {
        observedAt: new Date(now).toISOString(),

        telemetry: {
          pumpDuty: state.pumpDuty ?? null,
          rawCommandDuty: state.rawCommandDuty ?? null,
          flowRate: state.flowRate ?? null,
          motorTemp: state.motorTemp ?? null,
          vwc: state.vwc ?? null,
          setpoint: state.setpoint ?? state.target ?? null,
          vibrationRms:
            state.assetHealth?.vibrationRms ??
            state.vibrationRms ??
            null,

          safety: {
            systemStatus: isSafetyTripped
              ? 'CRITICAL'
              : (currentSafety.systemStatus || 'UNKNOWN'),
            alarms,
            tripped: Boolean(isSafetyTripped)
          },

          aiEngine: ai,
          predictiveAI: latestAIPrediction ?? null,
          autonomousMPC: mpcDuty ?? null
        },

        vibrationSnapshot,

        diagnostics: createDiagnosticsSnapshot(vibrationSnapshot, {
          status: ai.online ? 'ONLINE' : 'FALLBACK',
          engine: ai.online
            ? 'Python-FastAPI'
            : 'Node-ISO10816-Baseline'
        }),

        mlPrediction: mlPredictionStore.get(),
        mlPredictionStatus: mlPredictionStore.getStatus()
      };
    }
  });

  hydroSyncAgentInstance = createHydroSyncAgent({ toolset });

  return hydroSyncAgentInstance;
}

// Lightweight per-IP token bucket so this route can't be used as a free,
// unlimited proxy to your Gemini quota by an unauthenticated visitor.
const chatRateState = new Map();
function chatRateOk(ip) {
  const now = Date.now();
  let bucket = chatRateState.get(ip);
  if (!bucket) { bucket = { tokens: 6, last: now }; chatRateState.set(ip, bucket); }
  const elapsed = (now - bucket.last) / 1000;
  bucket.tokens = Math.min(6, bucket.tokens + elapsed * (6 / 60)); // 6 msgs/min refill
  bucket.last = now;
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}

app.post('/api/chat', async (req, res) => {
  const clientIp = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip;
  if (!chatRateOk(clientIp)) {
    return res.status(429).json({ reply: 'Rate limit exceeded — please wait a moment before sending another query.', error: 'RATE_LIMITED' });
  }

  const { message } = req.body || {};
  if (typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ reply: 'No query provided.', error: 'INVALID_REQUEST' });
  }
  let sessionId = typeof req.body.sessionId === 'string' ? req.body.sessionId : '';
  if (req.body.newConversation === true || !chatConversationStore.getHistory(sessionId)) {
    sessionId = chatConversationStore.create();
  }
  const conversationHistory = chatConversationStore.getHistory(sessionId) || [];
  // Runtime context comes from the server, never from user-controlled request data.
  const currentServerState = simulator.getState();
  const currentSafety = safetyCheck || {};
  const safety = isSafetyTripped
    ? 'CRITICAL'
    : (currentSafety.systemStatus || currentServerState.systemHealth || 'UNKNOWN');
  const activeZone = currentServerState.activeZoneId || 'UNKNOWN';
  try {
    const agent = getHydroSyncAgent();

let timeoutId;
const controller = new AbortController();

const timeoutPromise = new Promise((_, reject) => {
  timeoutId = setTimeout(
    () => {
      controller.abort();
      reject(new Error('Gemini request timed out'));
    },
    CHAT_TIMEOUT_MS
  );
});

let finalReply;

try {
  finalReply = await Promise.race([
    agent.answer({
      message: message.trim(),
      safety,
      activeZone,
      history: conversationHistory,
      signal: controller.signal
    }),
    timeoutPromise
  ]);
} finally {
  clearTimeout(timeoutId);
}

chatConversationStore.append(sessionId, message.trim(), finalReply);
return res.json({ reply: finalReply, sessionId });
  } catch (error) {
    // Full detail server-side; a distinct, honest reply per failure mode to the client —
    // the previous version reused one sentence for every branch, which is why the UI
    // looked identical regardless of what actually failed.
    console.error('[AI Chat] Error details:', {
  name: error.name,
  message: error.message,
  status: error.status || null,
  cause: error.cause ? {
    name: error.cause.name,
    code: error.cause.code,
    message: error.cause.message,
    nestedCause: error.cause.cause ? {
      name: error.cause.cause.name,
      code: error.cause.cause.code,
      message: error.cause.cause.message
    } : null,
    nestedErrors: Array.isArray(error.cause.errors)
      ? error.cause.errors.map(e => ({
          name: e.name,
          code: e.code,
          message: e.message
        }))
      : []
  } : null
});
    const status = error.message === 'GEMINI_API_KEY is not set' ? 503
      : error.message === 'Gemini request timed out' ? 504
      : (error.status === 404 ? 502 : 500);
    const byStatus = {
      503: { reply: 'Copilot is not configured on the server yet — no Gemini API key is set.', error: 'AI_NOT_CONFIGURED' },
      504: { reply: 'Copilot timed out waiting on a response. Try again in a moment.', error: 'AI_TIMEOUT' },
      502: { reply: 'Copilot model is currently unavailable upstream. Falling back to local monitoring.', error: 'AI_MODEL_UNAVAILABLE' },
      500: { reply: 'Copilot hit an unexpected error. Falling back to local monitoring.', error: 'AI_ERROR' }
    };
    res.status(status).json(byStatus[status]);
  }
});

// ─── Demo Mode Endpoints ─────────────────────────────────────────────────
app.post('/api/demo/start', (req, res) => {
  try {
    const maxCycles = (req.body && Number(req.body.maxCycles)) || 1;
    const result = demoMode.start(simulator, {
      maxCycles,
      onStateChange: (demoState) => {
        activeDemoState = demoState;
      }
    });
    if (!result.started) return res.status(409).json(result);
    isSafetyTripped = false;
    activeSafetyReason = '';
    resetSafetyState();
    mlPredictionStore.clear();
    pwmHistory = [];
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/demo/quick/start', (_req, res) => {
  try {
    const result = demoMode.startQuick(simulator, {
      onStateChange: (demoState) => {
        activeDemoState = demoState;
      }
    });
    if (!result.started) return res.status(409).json(result);
    isSafetyTripped = false;
    activeSafetyReason = '';
    resetSafetyState();
    mlPredictionStore.clear();
    pwmHistory = [];
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/demo/stop', (req, res) => {
  try {
    const result = demoMode.stop();
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/demo/status', (req, res) => {
  res.json(demoMode.getStatus());
});


server.listen(PORT, async () => {

  try {

    if (!autoCollectOptions) {
      await telemetryCollector.startExperiment();
    }

    console.log(`🗄️ TimescaleDB telemetry collection [ONLINE]`);

    if (autoCollectOptions) {
      console.log(
        `[RUNNER] Auto-collection enabled: ${autoCollectOptions.repeats} repeat(s), ` +
        `${autoCollectOptions.samplesPerBlock} samples per block`
      );
      runAutoCollection({
        simulator,
        telemetryCollector,
        ...autoCollectOptions,
        onSample: broadcastTelemetry
      })
        .catch(err => {
          console.error(`[RUNNER] Collection failed: ${err.message}`);
        })
        .finally(() => {
          if (!isShuttingDown) startTelemetryInterval();
        });
    } else {
      startTelemetryInterval();
    }

  } catch (err) {

    console.error(`[DB] Failed to start telemetry experiment: ${err.message}`);
    startTelemetryInterval();

  }

  console.log(`🌿 HydroSync SCADA running at http://localhost:${PORT}`);

  console.log(`🛡️ Enterprise Security Suite Active: Timing-Safe Auth, CSP, Rate-Limiting`);

  console.log(`⚙️ Core Safety Interlocks & ISO 10816 Diagnostics [ONLINE]`);

  console.log(`🧠 Weather-Aware Autonomous MPC Irrigation Engine [ONLINE]`);

  console.log(`🔗 Python AI Engine Gateway Ready at /api/ai/diagnostics`);

  console.log(`🔗 Python Vibration FFT Proxy Ready at /api/ai/vibration`);

});
