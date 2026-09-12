/**
 * server.js - HydroSync Express Server with Socket.io
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

/* ==========================================
 *  SOCKET.IO EVENT HANDLING
 *  ========================================== */
io.on('connection', (socket) => {
  console.log(`🔌 Client connected: ${socket.id}`);

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

  // 2b. Client: Update physical system settings
  socket.on('client:update_settings', (settings) => {
    if (!settings || typeof settings !== 'object') return;
    simulator.setSettings(settings);
    broadcastTelemetry();
  });

  // 3. Client: Inject disturbance
  socket.on('client:disturbance', (type) => {
    if (!type || (type !== 'drought' && type !== 'rain')) return;
    simulator.injectDisturbance(type);
    broadcastTelemetry();
  });

  // 3b. Client: Select active monitoring zone
  socket.on('client:select_zone', (id) => {
    if (typeof id !== 'string') return;
    simulator.setActiveZone(id);
    broadcastTelemetry();
  });

  // 4. Client: Toggle manual mode
  socket.on('client:manual_override', (data) => {
    if (data === undefined) return;
    const enabled = data.enabled !== undefined ? data.enabled : false;
    const pwm = data.manualPwm !== undefined ? data.manualPwm : simulator.getState().pumpDuty;
    simulator.setManualMode(enabled, pwm);
    broadcastTelemetry();
  });

  socket.on('disconnect', () => {
    console.log(`❌ Client disconnected: ${socket.id}`);
  });
});

/* ==========================================
 *  BROADCAST TELEMETRY PACKET (every 1 second)
 *  ========================================== */
broadcastTelemetry();

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

/* ==========================================
 *  START SERVER
 *  ========================================== */
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🌿 HydroSync Server running at http://localhost:${PORT}`);
  console.log(`📡 Telemetry broadcasting every 1s (SDG 6 & 13 Aligned)`);
});