/**
 * server.js - HydroSync Industrial SCADA Server with Satellite Weather Ingestion
 * Fully integrated with Open-Meteo API & Socket.io Real-time Telemetry
 */
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const simulator = require('./simulator');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

let serverStartTime = Date.now();

app.use(express.static('public'));

/* ==========================================================================
 *  SATELLITE WEATHER INGESTION (Open-Meteo API)
 * ========================================================================== */
const LOCATION_COORDINATES = {
  'setif': { lat: 36.19, lon: 5.41, name: 'Sétif (High Plains - Cereal)' },
  'biskra': { lat: 34.85, lon: 5.73, name: 'Biskra (Oasis - Greenhouse)' },
  'eloued': { lat: 33.37, lon: 6.86, name: 'El Oued (Desert Basin - Tubers)' },
  'mitidja': { lat: 36.47, lon: 2.83, name: 'Mitidja (Coastal Plains - Orchards)' }
};

let activeLocationKey = 'setif';

/**
 * Fetches satellite weather asynchronously from Open-Meteo
 * Safe fallback: Never crashes server if network fails
 */
async function fetchSatelliteWeather(key = 'setif') {
  try {
    const loc = LOCATION_COORDINATES[key] || LOCATION_COORDINATES['setif'];
    activeLocationKey = key;
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}&current=temperature_2m,relative_humidity_2m,precipitation,wind_speed_10m,weather_code,et0_fao_evapotranspiration`;
    
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Weather API HTTP ${response.status}`);
    const data = await response.json();
    const cur = data.current || {};

    const weatherPayload = {
      location: loc.name,
      temp: cur.temperature_2m !== undefined ? cur.temperature_2m : 24.0,
      humidity: cur.relative_humidity_2m !== undefined ? cur.relative_humidity_2m : 50,
      rain: cur.precipitation !== undefined ? cur.precipitation : 0.0,
      windSpeed: cur.wind_speed_10m !== undefined ? cur.wind_speed_10m : 8.0,
      weatherCode: cur.weather_code !== undefined ? cur.weather_code : 0,
      et0: cur.et0_fao_evapotranspiration !== undefined ? cur.et0_fao_evapotranspiration : 4.2
    };

    simulator.setLiveWeather(weatherPayload);
    console.log(`🛰️ Satellite Weather synced for [${loc.name}]: ${weatherPayload.temp}°C, ET0: ${weatherPayload.et0} mm/day`);
  } catch (err) {
    console.warn(`⚠️ Weather API fallback mode: ${err.message}`);
  }
}

// Initial satellite poll on server boot
fetchSatelliteWeather('setif');
// Periodic background refresh every 10 minutes
setInterval(() => fetchSatelliteWeather(activeLocationKey), 10 * 60 * 1000);

/* ==========================================================================
 *  SOCKET.IO EVENT DISPATCHER
 * ========================================================================== */
io.on('connection', (socket) => {
  console.log(`🔌 Client connected: ${socket.id}`);

  // Send initial snapshot
  const initialState = simulator.getState();
  socket.emit('telemetry', initialState);

  // 1. Client: Update PID parameters
  socket.on('client:update_pid', (params) => {
    if (!params) return;
    simulator.setPIDParams({
      kp: params.kp !== undefined ? params.kp : simulator.getState().kp,
      ki: params.ki !== undefined ? params.ki : simulator.getState().ki,
      kd: params.kd !== undefined ? params.kd : simulator.getState().kd
    });
    broadcastTelemetry();
  });

  // 2. Client: Update target setpoint
  socket.on('client:update_setpoint', (sp) => {
    if (sp === undefined) return;
    simulator.setTargetSetpoint(sp);
    broadcastTelemetry();
  });

  // 3. Client: Update physical system settings
  socket.on('client:update_settings', (settings) => {
    if (!settings || typeof settings !== 'object') return;
    simulator.setSettings(settings);
    broadcastTelemetry();
  });

  // 4. Client: Inject environmental disturbance
  socket.on('client:disturbance', (type) => {
    if (!type || (type !== 'drought' && type !== 'rain')) return;
    simulator.injectDisturbance(type);
    broadcastTelemetry();
  });

  // 5. Client: Select active micro-plot zone
  socket.on('client:select_zone', (id) => {
    if (typeof id !== 'string') return;
    simulator.setActiveZone(id);
    broadcastTelemetry();
  });

  // 6. Client: Manual Actuator Override
  socket.on('client:manual_override', (data) => {
    if (data === undefined) return;
    const enabled = data.enabled !== undefined ? data.enabled : false;
    const pwm = data.manualPwm !== undefined ? data.manualPwm : simulator.getState().pumpDuty;
    simulator.setManualMode(enabled, pwm);
    broadcastTelemetry();
  });

  // 7. Client: Change Agricultural Geolocation (Satellite Weather)
  socket.on('client:set_location', async (locationKey) => {
    if (LOCATION_COORDINATES[locationKey]) {
      await fetchSatelliteWeather(locationKey);
      broadcastTelemetry();
    }
  });

  socket.on('disconnect', () => {
    console.log(`❌ Client disconnected: ${socket.id}`);
  });
});

/* ==========================================================================
 *  BROADCAST TELEMETRY PACKET (every 1 second)
 * ========================================================================== */
const TELEMETRY_INTERVAL = 1000;
setInterval(() => {
  broadcastTelemetry();
}, TELEMETRY_INTERVAL);

function broadcastTelemetry() {
  simulator.pidLoop();
  const state = simulator.getState();
  const uptimeSeconds = Math.floor((Date.now() - serverStartTime) / 1000);
  const mins = Math.floor(uptimeSeconds / 60);
  const secs = uptimeSeconds % 60;

  io.emit('telemetry', {
    ...state,
    uptimeSeconds: uptimeSeconds,
    uptimeMinutes: mins,
    uptimeSecs: secs
  });
}

/* ==========================================================================
 *  START SERVER
 * ========================================================================== */
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🌿 HydroSync Industrial SCADA Server running at http://localhost:${PORT}`);
  console.log(`📡 Telemetry broadcasting every 1s (IEC 61508 & Open-Meteo Linked)`);
});