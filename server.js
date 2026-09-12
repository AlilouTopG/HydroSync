/**
 * server.js - HydroSync Express Server with Socket.io
 * 
 * Refactored for full-stack synchronization with simulator.js and public/app.js.
 * 
 * Features:
 * - Broadcasts unified 'telemetry' packet every 1 second
 * - Listens for client socket events: update_pid, update_setpoint, disturbance, manual_override
 * - Tracks server uptime for header display
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const simulator = require('./simulator'); // Import our PID/simulator module

const app = express();
const server = http.createServer(app);

// Initialize Socket.io with CORS configuration
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// --- === Server State === ---
let serverStartTime = Date.now();

// --- === Serve Static Files === ---
app.use(express.static('public'));

/* ==========================================
 *  SOCKET.IO EVENT HANDLING
 *  ========================================== */
io.on('connection', (socket) => {
  console.log(`🔌 Client connected: ${socket.id}`);

  // Send initial simulator state to newly connected client
  const initialState = simulator.getState();
  socket.emit('telemetry', initialState);
  console.log(`📡 Initial telemetry sent to ${socket.id}`);

  // --- Listen for client events ---

  // 1. Client: Update PID parameters
  socket.on('client:update_pid', (params) => {
    if (!params) return;
    simulator.setPIDParams({
      kp: params.kp !== undefined ? params.kp : simulator.getState().kp,
      ki: params.ki !== undefined ? params.ki : simulator.getState().ki,
      kd: params.kd !== undefined ? params.kd : simulator.getState().kd
    });
    // Broadcast updated state to ALL clients
    broadcastTelemetry();
  });

  // 2. Client: Update target setpoint
  socket.on('client:update_setpoint', (sp) => {
    if (sp === undefined) return;
    simulator.setTargetSetpoint(sp);
    broadcastTelemetry();
  });

  // 2b. Client: Update physical system settings (setpoint, tank capacity, soil type)
  socket.on('client:update_settings', (settings) => {
    if (!settings || typeof settings !== 'object') return;
    simulator.setSettings(settings);
    broadcastTelemetry();
  });

  // 3. Client: Inject disturbance (drought/rain)
  socket.on('client:disturbance', (type) => {
    if (!type || (type !== 'drought' && type !== 'rain')) return;
    simulator.injectDisturbance(type);
    broadcastTelemetry();
  });

  // 4. Client: Toggle manual mode and PWM output
  socket.on('client:manual_override', (data) => {
    if (data === undefined) return;
    const enabled = data.enabled !== undefined ? data.enabled : false;
    const pwm = data.manualPwm !== undefined ? data.manualPwm : simulator.getState().pumpDuty;
    simulator.setManualMode(enabled, pwm);
    broadcastTelemetry();
  });

  // 5. Client disconnect
  socket.on('disconnect', () => {
    console.log(`❌ Client disconnected: ${socket.id}`);
  });
})

/* ==========================================
 *  BROADCAST TELEMETRY PACKET (every 1 second)
 *  ========================================== */
// Initial broadcast
broadcastTelemetry();

// Set up interval to broadcast telemetry every 1 second
const TELEMETRY_INTERVAL = 1000;
setInterval(() => {
  broadcastTelemetry();
}, TELEMETRY_INTERVAL);

/**
 * Compute next PID loop step and broadcast unified telemetry packet.
 */
function broadcastTelemetry() {
  // Advance the simulator's internal PID loop by one step
  simulator.pidLoop();

  // Get the full state
  const state = simulator.getState();

  // Calculate server uptime
  const uptimeSeconds = Math.floor((Date.now() - serverStartTime) / 1000);
  const mins = Math.floor(uptimeSeconds / 60);
  const secs = uptimeSeconds % 60;

  // Emit unified telemetry packet to ALL connected clients
  // (spread forwards physics fields: et0, solarRad, tankVolumeL, waterSavedL, soilType, isManual…)
  io.emit('telemetry', {
    ...state,
    uptimeSeconds: uptimeSeconds,
    uptimeMinutes: mins,
    uptimeSecs: secs
  });

  // Log to server console periodically (every 10 broadcasts)
  // console.log(`📡 Telemetry broadcast: VWC=${state.vwc.toFixed(1)}% SP=${state.setpoint}% Pump=${state.pumpDuty}%`);
}

/* ==========================================
 *  START SERVER
 *  ========================================== */
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🌿 HydroSync Server running at http://localhost:${PORT}`);
  console.log(`📡 Telemetry broadcasting every 1s (SDG 6 & 13 Aligned)`);
});