/**
 * server.js - HydroSync SCADA Server (Hardened Production Release)
 * Security Hardening: Anti-SSRF, Strict CORS, CSP, Timing-Safe Auth, Rate-Limiter
 * Features: Live Satellite Weather Ingestion & GIS Fleet Map Support
 */
const express = require('express');
const http = require('http');
const crypto = require('crypto');
const { Server } = require('socket.io');
const simulator = require('./simulator');

const app = express();
const server = http.createServer(app);

// 1. Information Disclosure Mitigation
app.disable('x-powered-by');

// 2. Strict Security Headers & Content Security Policy (Expanded for Leaflet & CartoDB Dark Tiles)
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
    "connect-src 'self' wss: https:; " +
    "img-src 'self' data: https: https://*.basemaps.cartocdn.com https://*.tile.openstreetmap.org;"
  );
  next();
});

// 3. Prevent Path Traversal on static serving
app.use(express.static('public', {
  dotfiles: 'ignore',
  index: ['index.html']
}));

// 4. Tighten CORS for Socket.io
const isProduction = process.env.NODE_ENV === 'production';
const io = new Server(server, {
  cors: {
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (!isProduction || origin.includes('onrender.com') || origin.includes('localhost')) {
        return callback(null, true);
      }
      return callback(new Error('Blocked by SCADA CORS Policy'), false);
    },
    methods: ['GET', 'POST']
  }
});

let serverStartTime = Date.now();
const OPERATOR_PIN = process.env.OPERATOR_PIN || '8492';

/* ==========================================================================
 *  SECURITY ENGINE: RATE LIMITING & TIMING-SAFE AUTH
 * ========================================================================== */
const clientFirewallState = new Map();
const failedAttemptsByIp = new Map();
let totalThreatsBlocked = 0;

function safeCompare(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
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

/* ==========================================================================
 *  SSRF-SAFE SATELLITE WEATHER INGESTION (Corrected Open-Meteo Spec)
 * ========================================================================== */
const LOCATION_COORDINATES = Object.freeze({
  'setif': Object.freeze({ lat: 36.19, lon: 5.41, name: 'Sétif (High Plains - Cereal)' }),
  'biskra': Object.freeze({ lat: 34.85, lon: 5.73, name: 'Biskra (Oasis - Palms/Greenhouse)' }),
  'eloued': Object.freeze({ lat: 33.37, lon: 6.86, name: 'El Oued (Desert Basin - Tubers)' }),
  'mitidja': Object.freeze({ lat: 36.56, lon: 2.91, name: 'Mitidja (Coastal Plains - Citrus)' })
});

let activeLocationKey = 'setif';

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
    url.searchParams.set('daily', 'et0_fao_evapotranspiration');
    url.searchParams.set('timezone', 'auto');
    
    const response = await fetch(url.toString(), { signal: AbortSignal.timeout(6000) });
    if (!response.ok) throw new Error(`Open-Meteo HTTP ${response.status}`);
    
    const data = await response.json();
    const cur = data.current || {};
    const daily = data.daily || {};

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
    console.log(`🛰️ [SATELLITE LIVE] ${loc.name} -> ${liveData.temp}°C | Wind: ${liveData.windSpeed} km/h | RH: ${liveData.humidity}% | ET0: ${liveData.et0} mm/day`);
  } catch (err) {
    console.warn(`⚠️ Weather API fallback: ${err.message}`);
  }
}

fetchSatelliteWeather('setif');
setInterval(() => fetchSatelliteWeather(activeLocationKey), 10 * 60 * 1000);

/* ==========================================================================
 *  EVENT DISPATCHER WITH STRICT INPUT VALIDATION
 * ========================================================================== */
io.on('connection', (socket) => {
  const clientIp = socket.handshake.address || 'unknown';
  clientFirewallState.set(socket.id, { tokens: 10, lastRefill: Date.now(), authorized: false });

  const initialState = simulator.getState();
  socket.emit('telemetry', { ...initialState, threatsBlocked: totalThreatsBlocked });

  // 1. Operator Authentication with Anti-Brute-Force Lockout
  socket.on('client:auth', (submittedPin) => {
    if (!firewallValidate(socket, 1)) return;

    const lockData = failedAttemptsByIp.get(clientIp) || { count: 0, lockedUntil: 0 };
    const now = Date.now();

    if (lockData.lockedUntil > now) {
      const waitSecs = Math.ceil((lockData.lockedUntil - now) / 1000);
      socket.emit('auth:failed', { msg: `Console locked due to multiple failed attempts. Wait ${waitSecs}s.` });
      return;
    }

    if (typeof submittedPin === 'string' && safeCompare(submittedPin.trim(), OPERATOR_PIN)) {
      failedAttemptsByIp.delete(clientIp);
      const client = clientFirewallState.get(socket.id);
      if (client) client.authorized = true;
      socket.emit('auth:success', { authorized: true });
    } else {
      totalThreatsBlocked++;
      lockData.count++;
      if (lockData.count >= 5) {
        lockData.lockedUntil = now + 15 * 60 * 1000;
      }
      failedAttemptsByIp.set(clientIp, lockData);
      socket.emit('auth:failed', { msg: 'Invalid Operator Passcode.' });
    }
  });

  // 2. Input Sanitization on PID parameters
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

  // 3. Input Sanitization on Setpoint
  socket.on('client:update_setpoint', (sp) => {
    if (!firewallValidate(socket, 1)) return;
    const target = Number(sp);
    if (Number.isFinite(target)) {
      simulator.setTargetSetpoint(Math.max(10.0, Math.min(95.0, target)));
      broadcastTelemetry();
    }
  });

  // 4. Physical System Settings with Whitelist
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

  // 5. Injection Protection on Disturbance
  socket.on('client:disturbance', (type) => {
    if (!firewallValidate(socket, 3)) return;
    if (type === 'drought' || type === 'rain') {
      simulator.injectDisturbance(type);
      broadcastTelemetry();
    }
  });

  // 6. Whitelist Pattern Protection on Zone Selection
  socket.on('client:select_zone', (id) => {
    if (!firewallValidate(socket, 1)) return;
    if (typeof id === 'string' && /^[A-B][1-3]$/.test(id)) {
      simulator.setActiveZone(id);
      broadcastTelemetry();
    }
  });

  // 7. Manual Override Sanitization
  socket.on('client:manual_override', (data) => {
    if (!firewallValidate(socket, 2) || !verifyOperatorAuth(socket)) return;
    if (!data || typeof data !== 'object') return;
    simulator.setManualMode(Boolean(data.enabled), Math.max(0.0, Math.min(100.0, Number(data.manualPwm) || 0)));
    broadcastTelemetry();
  });

  // 8. Whitelist Location Key
  socket.on('client:set_location', async (locationKey) => {
    if (!firewallValidate(socket, 2)) return;
    if (typeof locationKey === 'string' && Object.prototype.hasOwnProperty.call(LOCATION_COORDINATES, locationKey)) {
      await fetchSatelliteWeather(locationKey);
      broadcastTelemetry();
    }
  });

  socket.on('disconnect', () => {
    clientFirewallState.delete(socket.id);
  });
});

/* ==========================================================================
 *  BROADCAST LOOP
 * ========================================================================== */
const TELEMETRY_INTERVAL = 1000;
setInterval(() => {
  broadcastTelemetry();
}, TELEMETRY_INTERVAL);

function broadcastTelemetry() {
  simulator.pidLoop();
  const state = simulator.getState();
  const uptimeSeconds = Math.floor((Date.now() - serverStartTime) / 1000);

  io.emit('telemetry', {
    ...state,
    uptimeSeconds,
    uptimeMinutes: Math.floor(uptimeSeconds / 60),
    uptimeSecs: uptimeSeconds % 60,
    threatsBlocked: totalThreatsBlocked
  });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🌿 HydroSync SCADA running at http://localhost:${PORT}`);
  console.log(`🛡️ Enterprise Security Suite Active: Timing-Safe Auth, CSP, Anti-SSRF, Rate-Limiting`);
});