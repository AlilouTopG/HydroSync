/**

 * server.js - HydroSync SCADA Server (Hardened Production Release)

 * Architecture: Node.js Telemetry Ingestion + Safety Interlocks + AI MPC Bridge

 * Security Hardening: Anti-SSRF, Strict CORS, CSP, Timing-Safe Auth, Rate-Limiter

 * Features: Live Weather, GIS Fleet Map, 24h AI MPC, Asset Health & CSV Audit Endpoint

 */

const express = require('express');

const http = require('http');

const path = require('path');

const crypto = require('crypto');

const { Server } = require('socket.io');

const simulator = require('./simulator');

const DEBUG = false;



// استدعاء نواة التحكم وصمامات الأمان الخاصة بك

const { evaluateSafety, calculateIrrigationDuty, resetSafetyState } = require('./core_control/mpc_controller');



const app = express();

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



// 3. Python AI Engine Bridge Endpoint (مجهز لعبد الحق وسيرين)

const AI_ENGINE_URL = process.env.AI_ENGINE_URL || 'http://localhost:8000';

let latestVibrationFeatures = null;

let latestVibrationFFT = null;

let pythonBridgeOfflineLogged = false;

function isUsableFft(fft) {

  return Boolean(

    fft &&

    Array.isArray(fft.magnitudes) &&

    fft.magnitudes.length > 0 &&

    Array.isArray(fft.frequencies_hz)

  );

}

function cachePythonVibration(data) {

  if (!data || typeof data !== 'object') return;

  if (data.features) latestVibrationFeatures = data.features;

  if (isUsableFft(data.fft)) latestVibrationFFT = data.fft;

}

app.get('/api/ai/diagnostics', async (req, res) => {

  try {

    const [diagRes, vibRes] = await Promise.all([

      fetch(`${AI_ENGINE_URL}/diagnostics`, { signal: AbortSignal.timeout(3000) }),

      fetch(`${AI_ENGINE_URL}/vibration/latest`, { signal: AbortSignal.timeout(3000) }).catch(() => null)

    ]);

    if (!diagRes.ok) throw new Error(`AI Engine status: ${diagRes.status}`);

    const diagnostics = await diagRes.json();

    let vibration = null;

    if (vibRes && vibRes.ok) {

      vibration = await vibRes.json();

      cachePythonVibration(vibration);

    }

    const fftPayload = isUsableFft(vibration && vibration.fft)

      ? vibration.fft

      : latestVibrationFFT;

    const diagnosticsOut = {

      ...(diagnostics && typeof diagnostics === 'object' ? diagnostics : {}),

      fft: fftPayload,

      features: latestVibrationFeatures

    };

    res.json({

      status: 'ONLINE',

      engine: 'Python-FastAPI',

      diagnostics: diagnosticsOut,

      vibration,

      fft: fftPayload,

      features: latestVibrationFeatures

    });

  } catch (err) {

    res.json({

      status: 'FALLBACK',

      engine: 'Node-ISO10816-Baseline',

      diagnostics: {

        fft: latestVibrationFFT,

        features: latestVibrationFeatures

      },

      fft: latestVibrationFFT,

      features: latestVibrationFeatures,

      msg: 'Python AI Engine in ai_engine/ is currently offline. Operating on local safety interlocks.'

    });

  }

});



app.get('/api/ai/vibration', async (req, res) => {

  try {

    const response = await fetch(`${AI_ENGINE_URL}/vibration/latest`, { signal: AbortSignal.timeout(3000) });

    if (!response.ok) throw new Error(`AI Engine status: ${response.status}`);

    const data = await response.json();

    cachePythonVibration(data);

    res.json({

      status: 'ONLINE',

      engine: 'Python-FastAPI',

      waveform: data.waveform,

      fft: data.fft,

      features: latestVibrationFeatures

    });

  } catch (err) {

    res.json({

      status: 'FALLBACK',

      engine: 'Node-ISO10816-Baseline',

      waveform: null,

      fft: latestVibrationFFT,

      features: latestVibrationFeatures,

      msg: 'Python AI Engine is currently offline. Serving last cached FFT if available.'

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



// إدارة حالات الأمان والقفل الصناعي (Trip Latching)

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

    socket.emit('firewall:alert', {

      type: 'RATE_LIMIT_EXCEEDED',

      msg: 'Command rate limit exceeded. Action dropped.'

    });

    return false;

  }



  client.tokens -= cost;

  return true;

}



function verifyOperatorAuth(socket) {

  const client = clientFirewallState.get(socket.id);

  if (!client || !client.authorized) {

    totalThreatsBlocked++;

    socket.emit('firewall:alert', {

      type: 'UNAUTHORIZED_ACCESS',

      msg: 'Access Denied: Action requires authenticated Operator credentials.'

    });

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

    if (!Object.prototype.hasOwnProperty.call(LOCATION_COORDINATES, key)) {

      key = 'setif';

    }

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

      et0: (Array.isArray(daily.et0_fao_evapotranspiration) && daily.et0_fao_evapotranspiration.length > 0)

        ? Number(daily.et0_fao_evapotranspiration[0])

        : 4.2

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

        rationale: willRainSoon

          ? `Precipitation front detected (Peak: ${maxRainProb12h}%, Cumul: ${totalRain24h.toFixed(1)}mm). Pump dispatch postponed to leverage natural precipitation.`

          : `Clear atmospheric outlook across next 24h. Soil moisture depletion will follow standard PID setpoint.`

      };

    // Hook rain hold directly into the simulator
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

  // Build safety object matching broadcastTelemetry shape exactly to prevent nominal flash on late joins
  const initialSafety = {
    systemStatus: isSafetyTripped ? 'CRITICAL' : 'NORMAL',
    alarms: isSafetyTripped ? [activeSafetyReason] : [],
    tripped: isSafetyTripped
  };

  socket.emit('telemetry', { 

    ...initialState, 

    threatsBlocked: totalThreatsBlocked,

    predictiveAI: latestAIPrediction,

    safety: initialSafety,

    fft: latestVibrationFFT

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

      AUTH_BUDGET.fails++;

      lockData.count++;

      if (lockData.count >= 5) {

        lockData.lockedUntil = now + 2 * 60 * 1000;

      }

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

    console.log('âœ… [SCADA TRIP RESET]: Operator cleared the safety lock.');
    broadcastTelemetry();

  });




  // ðŸš¨ Public Emergency Stop (idempotent, no PIN required)
  socket.on('client:emergency_stop', () => {

    if (isSafetyTripped) return;

    isSafetyTripped = true;

    activeSafetyReason = 'OPERATOR EMERGENCY STOP';

    simulator.setManualMode(true, 0);

    broadcastTelemetry();

  });




  // ðŸ§ª Operator Fault Injection (requires auth)
  socket.on('client:inject_fault', (type) => {

    if (!firewallValidate(socket, 2) || !verifyOperatorAuth(socket)) return;

    if (['bearing', 'overheat', 'clear'].includes(type)) {

      simulator.injectFault(type);

      broadcastTelemetry();

    }

  });





  socket.on('client:update_pid', (params) => {

    if (!firewallValidate(socket, 2) || !verifyOperatorAuth(socket)) return;

    if (!params || typeof params !== 'object') return;



    const kp = Number(params.kp);

    const ki = Number(params.ki);

    const kd = Number(params.kd);



    if (Number.isFinite(kp) && Number.isFinite(ki) && Number.isFinite(kd)) {

      simulator.setPIDParams({

        kp: Math.max(0, Math.min(10.0, kp)),

        ki: Math.max(0, Math.min(2.0, ki)),

        kd: Math.max(0, Math.min(5.0, kd))

      });

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



    simulator.setSettings({

      setpoint: cleanSetpoint,

      tankCapacity: cleanCap,

      soilType: cleanSoil

    });

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
let safetyCheck = { tripPump: false, systemStatus: 'NORMAL', alarms: [] };
let mpcDuty = { duty: 0, mode: 'CLOSED_LOOP_ACTIVE' };

function postVibration(state) {
  const waveform = (state.assetHealth && state.assetHealth.vibrationWaveform) || state.vibrationWaveform;
  if (aiInFlight || !Array.isArray(waveform) || !waveform.length) return;
  aiInFlight = true;
  fetch(AI_ENGINE_URL + '/vibration', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(800),
    body: JSON.stringify({
      vibrationWaveform: waveform,
      samplingRateHz: (state.assetHealth && state.assetHealth.samplingRateHz) || 1000,
      bufferSize: (state.assetHealth && state.assetHealth.bufferSize) || waveform.length
    })
  })
    .then(r => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then(d => {
      cachePythonVibration(d);
      aiLastOkAt = Date.now();
      pythonBridgeOfflineLogged = false;
    })
    .catch(() => {
      if (!pythonBridgeOfflineLogged) {
        pythonBridgeOfflineLogged = true;
        console.warn(`⚠️ Python AI Engine unreachable at ${AI_ENGINE_URL}/vibration — FFT charts will use local fallback until it comes online.`);
      }
    })
    .finally(() => { aiInFlight = false; });
}

function tick() {
  simulator.pidLoop();
  const state = simulator.getState();
  postVibration(state);
  safetyCheck = evaluateSafety({
    pumpState: Boolean(state.pumpDuty > 0 || state.rawCommandDuty > 0),
    pumpDuty: Number(state.pumpDuty) || 0,
    flowRate: Number(state.flowRate) || 0,
    motorTemp: Number(state.motorTemp) || 25,
    vibrationRms: typeof state.assetHealth?.vibrationRms === 'number' ? state.assetHealth.vibrationRms : (Number(state.vibrationRms) || 0)
  });
  if (safetyCheck.tripPump && !isSafetyTripped) {
    isSafetyTripped = true;
    activeSafetyReason = safetyCheck.alarms.join(' | ');
    simulator.setManualMode(true, 0);
    console.warn(`[SCADA SAFETY INTERLOCK TRIPPED]: ${activeSafetyReason}`);
  }
  mpcDuty = calculateIrrigationDuty(Number(state.vwc) || 20, Number(state.setpoint || state.target) || 55, Number(latestAIPrediction.maxRainProb12h) || 0);
  broadcastTelemetry();
}

function broadcastTelemetry() {
  const state = simulator.getState(), now = Date.now(), aiFresh = now - aiLastOkAt < 3000;
  const up = Math.floor((now - serverStartTime) / 1000);
  io.emit('telemetry', {
    ...state, uptimeSeconds: up, uptimeMinutes: Math.floor(up / 60), uptimeSecs: up % 60,
    threatsBlocked: totalThreatsBlocked, predictiveAI: latestAIPrediction,
    fft: aiFresh ? latestVibrationFFT : null,
    aiEngine: { online: aiFresh, ageMs: aiLastOkAt ? now - aiLastOkAt : null },
    safety: { systemStatus: isSafetyTripped ? 'CRITICAL' : safetyCheck.systemStatus, alarms: isSafetyTripped ? [activeSafetyReason] : safetyCheck.alarms, tripped: isSafetyTripped },
    autonomousMPC: mpcDuty
  });
}
setInterval(tick, TELEMETRY_INTERVAL);

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {

  console.log(`🌿 HydroSync SCADA running at http://localhost:${PORT}`);

  console.log(`🛡️ Enterprise Security Suite Active: Timing-Safe Auth, CSP, Rate-Limiting`);

  console.log(`⚙️ Core Safety Interlocks & ISO 10816 Diagnostics [ONLINE]`);

  console.log(`🧠 Weather-Aware Autonomous MPC Irrigation Engine [ONLINE]`);

  console.log(`🔗 Python AI Engine Gateway Ready at /api/ai/diagnostics`);

  console.log(`🔗 Python Vibration FFT Proxy Ready at /api/ai/vibration`);

}); 

