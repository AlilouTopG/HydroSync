/**
 * app.js - HydroSync Frontend Client (Competition-Grade SCADA Console)
 * 
 * Full-stack synchronization with simulator.js and server.js.
 * 
 * Features:
 * - Listens to 'telemetry' socket events from server
 * - Formats and displays uptime, VWC, actuator, flow, water saved
 * - Chart.js with FIFO capping (last 20 points)
 * - PID slider emissions: Kp, Ki, Kd, Setpoint
 * - Disturbance button emissions: 'drought' / 'rain'
 * - Manual override toggle
 */

// --- Configuration ---
const CHART_MAX_POINTS = 22;       // FIFO cap: 22 data points ~4.4s at 200ms
const SOCKET_URL = undefined;      // Will use relative path (same host)

// --- State Tracking ---
let socket = null;
let moistureHistory = [];
let timestamps = [];
let chartStartTime = null;
let currentSetpoint = 55.0;
let currentKp = 2.0, currentKi = 0.1, currentKd = 0.5;
let isManualOverride = false;
let pageLoadTime = Date.now();

// --- DOM Element Caching ---
let dom = null;

// --- Chart.js Instance ---
let mainChart = null;

/* ==========================================
 *  INITIALIZATION
 *  ========================================== */
function init() {
  // Cache all DOM elements
  dom = {
    // Header / Uptime
    heartbeatPulse: document.getElementById('heartbeatPulse'),
    connectionStatus: document.getElementById('connectionStatus'),
    statusText: document.getElementById('statusText'),
    pingDot: document.getElementById('pingDot'),
    uptimeTimer: document.getElementById('uptimeTimer'),

    // VWC Gauge
    vcwCard: document.getElementById('vcwCard'),
    vcwProgress: document.getElementById('vcwProgress'),
    vcwValue: document.getElementById('vcwValue'),
    vcwValueDisplay: document.getElementById('vcwValueDisplay'),
    vcwSetpointDisplay: document.getElementById('vcwSetpointDisplay'),

    // Actuator / PWM Gauge
    actuatorCard: document.getElementById('actuatorCard'),
    actuatorProgress: document.getElementById('actuatorProgress'),
    actuatorValue: document.getElementById('actuatorValue'),
    actuatorValueDisplay: document.getElementById('actuatorValueDisplay'),

    // Flow Rate Gauge
    flowCard: document.getElementById('flowCard'),
    flowProgress: document.getElementById('flowProgress'),
    flowValue: document.getElementById('flowValue'),
    flowValueDisplay: document.getElementById('flowValueDisplay'),

    // Conservation Efficiency Gauge
    conservationCard: document.getElementById('conservationCard'),
    conservationProgress: document.getElementById('conservationProgress'),
    conservationValue: document.getElementById('conservationValue'),
    conservationValueDisplay: document.getElementById('conservationValueDisplay'),

    // Main Telemetry Chart
    mainChartCanvas: document.getElementById('mainChart'),

    // PID Controls
    KpSlider: document.getElementById('KpSlider'),
    KiSlider: document.getElementById('KiSlider'),
    KdSlider: document.getElementById('KdSlider'),
    KpValue: document.getElementById('KpValue'),
    KiValue: document.getElementById('KiValue'),
    KdValue: document.getElementById('KdValue'),
    KpTerm: document.getElementById('KpTerm'),
    KiTerm: document.getElementById('KiTerm'),
    KdTerm: document.getElementById('KdTerm'),
    antiWindupLed: document.getElementById('antiWindupLed'),
    antiWindupIndicator: document.getElementById('antiWindupIndicator'),

    // Jury Demo
    droughtBtn: document.getElementById('droughtBtn'),
    rainBtn: document.getElementById('rainBtn'),
    resetBtn: document.getElementById('resetBtn'),
    juryBadge: document.getElementById('juryBadge'),
    graphMode: document.getElementById('graphMode'),
    pidMode: document.getElementById('pidMode')
  };

  // Initialize Chart.js with FIFO optimization
  initChart();

  // Connect to Socket.io server
  connectSocket();

  // Initialize control listeners
  initSetpointControls();
  initJuryDemo();

  // Start timers
  startUptimeTimer();
  startHeartbeat();
}

/* ==========================================
 *  CHART.JS INITIALIZATION WITH FIFO CAP
 *  ========================================== */
function initChart() {
  const ctx = dom.mainChartCanvas.getContext('2d');

  dom.mainChartCanvas.width = dom.mainChartCanvas.offsetWidth;
  dom.mainChartCanvas.height = 450;

  mainChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        {
          label: 'VWC Process Variable (%)',
          data: [],
          borderColor: '#00E5FF',
          backgroundColor: 'rgba(0, 229, 255, 0.08)',
          tension: 0.4,
          fill: true,
          pointRadius: 2,
          pointHoverRadius: 4,
          borderWidth: 2
        },
        {
          label: 'Target Setpoint (SP %)',
          data: [],
          borderColor: '#F59E0B',
          backgroundColor: 'rgba(245, 158, 11, 0.05)',
          tension: 0.4,
          fill: false,
          pointRadius: 0,
          borderDash: [12, 6],
          borderWidth: 2
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: {
        duration: 10,
        easing: 'linear'
      },
      scales: {
        y: {
          display: true,
          suggestedMin: 0,
          suggestedMax: 100,
          ticks: { color: 'rgba(255,255,255,0.4)', font: { size: 10 } },
          grid: { color: 'rgba(255,255,255,0.08)' }
        },
        x: {
          display: true,
          ticks: { color: 'rgba(255,255,255,0.4)', font: { size: 9 } },
          grid: { display: false }
        }
      },
      plugins: {
        legend: {
          display: true,
          position: 'top',
          labels: { color: 'rgba(255,255,255,0.5)', font: { size: 9 } }
        }
      }
    }
  });
}

/* ==========================================
 *  SOCKET.IO CONNECTION
 *  ========================================== */
function connectSocket() {
  socket = io(SOCKET_URL); // relative path = same host

  // --- Connection Lifecycle ---
  socket.on('connect', () => {
    updateConnection(true);
    startHeartbeat();
    console.log('🛰️ HydroSync SCADA Connected - Live Telemetry Stream');
  });

  socket.on('disconnect', () => {
    updateConnection(false);
    stopHeartbeat();
    console.log('⚡ HydroSync SCADA Offline');
  });

  // --- Initial State ---
  socket.on('telemetry', (data) => {
    applyInitialTelemetry(data);
    initChartState(data);
  });

  // --- Real-Time Telemetry Stream ---
  socket.on('telemetry', (data) => {
    updateTelemetryDisplays(data);
    addChartDataPoint(data.vwc);
  });

  // --- PID Parameter Updates from Server ---
  socket.on('pid-params-updated', (params) => {
    updatePIDSlidersUI(params);
    updatePIDTermBreakdowns(params);
  });

  // --- Manual Mode State from Server ---
  socket.on('manual-mode-state', (stateObj) => {
    isManualOverride = stateObj.isManual;
    updateManualOverrideToggle(isManualOverride);
  });
}

/* ==========================================
 *  APPLY INITIAL TELEMETRY FROM SERVER
 *  ========================================== */
function applyInitialTelemetry(data) {
  // Store current setpoint
  currentSetpoint = data.setpoint;

  // Update PID slider values
  if (dom.KpSlider) dom.KpSlider.value = data.kp || 2.0;
  if (dom.KiSlider) dom.KiSlider.value = data.ki || 0.1;
  if (dom.KdSlider) dom.KdSlider.value = data.kd || 0.5;

  // Update value displays
  if (dom.KpValue) dom.KpValue.textContent = (data.kp || 2.0).toFixed(2);
  if (dom.KiValue) dom.KiValue.textContent = (data.ki || 0.1).toFixed(4);
  if (dom.KdValue) dom.KdValue.textContent = (data.kd || 0.5).toFixed(2);

  // Initialize chart and gauges
  initChartState(data);
}

/** Initialize chart data arrays with initial telemetry */
function initChartState(data) {
  const initialVWC = data.vwc || 35.0;
  const initialSetpoint = data.setpoint || 55.0;
  const initialPump = data.pumpDuty || 0;
  const now = Date.now();
  chartStartTime = now;

  // Initialize FIFO arrays
  moistureHistory = [];
  timestamps = [];

  // Pre-fill with historical points
  for (let i = CHART_MAX_POINTS - 1; i >= 0; i--) {
    const ts = now - i * 200; // 200ms interval
    timestamps.push(ts);
    const variance = (Math.random() - 0.5) * 3;
    const val = Math.max(0, Math.min(100, initialVWC + variance));
    moistureHistory.push(val);
  }

  // Setpoint reference line (constant)
  const setpointLine = new Array(CHART_MAX_POINTS).fill(initialSetpoint);

  // Pump duty line (constant)
  const pumpLine = new Array(CHART_MAX_POINTS).fill(initialPump);

  // Generate time labels
  const timeLabels = timestamps.map(ts => {
    const diff = Math.floor((now - ts) / 1000);
    return `${diff}s`;
  });

  // Apply to Chart.js
  mainChart.data.labels = timeLabels;
  mainChart.data.datasets[0].data = moistureHistory;
  mainChart.data.datasets[1].data = setpointLine;
  mainChart.update('quiet');
}

/* ==========================================
 *  REAL-TIME TELEMETRY PROCESSING
 *  ========================================== */
function updateTelemetryDisplays(data) {
  if (!data) return;

  // 1. Uptime display in header
  updateUptimeDisplay(data.uptimeSeconds);

  // 2. VWC Circular Gauge
  updateVWCGauge(data.vwc);

  // 3. Actuator / PWM Output Gauge
  updateActuatorGauge(data.pumpDuty);

  // 4. Hydraulic Flow Rate
  updateFlowGauge(data.flowRate);

  // 5. Water Conservation Efficiency
  updateConservationEfficiency(data.waterSaved);

  // 6. Control Error & PID Terms
  updateControlError(data.error, data.pTerm, data.iTerm, data.dTerm);

  // 7. Update Setpoint Display
  if (dom.vcwSetpointDisplay) {
    dom.vcwSetpointDisplay.textContent = `SP: ${data.setpoint.toFixed(1)}%`;
  }

  // 8. Update PID mode badge
  if (dom.pidMode) {
    dom.pidMode.textContent = data.isManual === false ? 'AUTO' : 'MAN';
    dom.pidMode.className = `badge ${data.isManual ? 'badge-amber' : 'badge-cyan'}`;
  }
}

/** Update uptime HH:MM:SS in header */
function updateUptimeDisplay(uptimeSeconds) {
  if (!dom.uptimeTimer) return;
  const hrs = Math.floor(uptimeSeconds / 3600);
  const mins = Math.floor((uptimeSeconds % 3600) / 60);
  const secs = uptimeSeconds % 60;
  const secDisplay = secs < 10 ? '0' + secs : secs;
  dom.uptimeTimer.textContent = `${hrs}h ${mins}m ${secs}s`;
}

/** Update VWC radial gauge */
function updateVWCGauge(vwc) {
  const pct = Math.max(0, Math.min(100, vwc));
  const circumference = 502.65;

  dom.vcwProgress.style.strokeDasharray = circumference;
  dom.vcwProgress.style.strokeDashoffset = circumference - (circumference * pct / 100);

  dom.vcwValue.textContent = pct.toFixed(1);
  dom.vcwValueDisplay.textContent = `${pct.toFixed(1)}%`;
}

/** Update actuator PWM duty cycle gauge */
function updateActuatorGauge(pct) {
  const pwr = Math.max(0, Math.min(100, pct));
  const circumference = 502.65;

  dom.actuatorProgress.style.strokeDasharray = circumference;
  dom.actuatorProgress.style.strokeDashoffset = circumference - (circumference * pwr / 100);

  dom.actuatorValue.textContent = Math.round(pwr);
  dom.actuatorValueDisplay.textContent = `${Math.round(pwr)}%`;

  // Color coding
  if (pwr < 30) {
    dom.actuatorCard.style.borderColor = 'rgba(16,185,129,0.3)';
    dom.actuatorValue.style.color = '#10B981';
  } else if (pwr < 70) {
    dom.actuatorCard.style.borderColor = 'rgba(245,158,11,0.3)';
    dom.actuatorValue.style.color = '#F59E0B';
  } else {
    dom.actuatorCard.style.borderColor = 'rgba(239,68,68,0.3)';
    dom.actuatorValue.style.color = '#EF4444';
  }
}

/** Update hydraulic flow rate gauge */
function updateFlowGauge(lpm) {
  const lpmClamped = Math.max(0, Math.min(50, lpm || 0));
  const circumference = 502.65;

  dom.flowProgress.style.strokeDasharray = circumference;
  dom.flowProgress.style.strokeDashoffset = circumference - (circumference * lpmClamped / 50);

  dom.flowValue.textContent = `${lpmClamped} L/min`;
  dom.flowValueDisplay.textContent = `${lpmClamped} L/min`;
}

/** Update water conservation efficiency */
function updateConservationEfficiency(saved) {
  const pct = Math.max(0, Math.min(100, saved || 0)).toFixed(1);
  const circumference = 502.65;

  dom.conservationProgress.style.strokeDasharray = circumference;
  dom.conservationProgress.style.strokeDashoffset = circumference - (circumference * parseFloat(pct) / 100);

  dom.conservationValue.textContent = Math.round(parseFloat(pct));
  dom.conservationValueDisplay.textContent = `${Math.round(parseFloat(pct))}%`;

  // Color coding
  if (parseFloat(pct) >= 70) {
    dom.conservationCard.style.borderColor = 'rgba(16,185,129,0.3)';
    dom.conservationValue.style.color = '#10B981';
  } else if (parseFloat(pct) >= 40) {
    dom.conservationCard.style.borderColor = 'rgba(245,158,11,0.3)';
    dom.conservationValue.style.color = '#F59E0B';
  } else {
    dom.conservationCard.style.borderColor = 'rgba(239,68,68,0.3)';
    dom.conservationValue.style.color = '#EF4444';
  }
}

/** Update control error and PID term diagnostic readouts */
function updateControlError(error, pTerm, iTerm, dTerm) {
  if (!dom.vcwSetpointDisplay) return;
  dom.vcwSetpointDisplay.textContent = `SP: ${(data ? data.setpoint : 55).toFixed(1)}%`;

  // Diagnostic terms
  if (dom.KpTerm) dom.KpTerm.textContent = (pTerm || 0).toFixed(2);
  if (dom.KiTerm) dom.KiTerm.textContent = (iTerm || 0).toFixed(2);
  if (dom.KdTerm) dom.KdTerm.textContent = (dTerm || 0).toFixed(2);
}

/* ==========================================
 *  CHART DATA MANAGEMENT (FIFO)
 *  ========================================== */
function addChartDataPoint(vwc) {
  const now = Date.now();

  // Initialize chart start time
  if (!chartStartTime) chartStartTime = now;

  // FIFO: shift oldest if at capacity, push new
  if (moistureHistory.length >= CHART_MAX_POINTS) {
    moistureHistory.shift();
    timestamps.shift();
  }

  // Push new VWC value
  moistureHistory.push(vwc);
  timestamps.push(now);

  // Generate relative time labels
  const timeLabels = timestamps.map(ts => {
    const diff = Math.floor((now - ts) / 1000);
    return `${diff}s`;
  });

  // Update Chart.js data
  mainChart.data.labels = timeLabels;
  mainChart.data.datasets[0].data = moistureHistory;
  mainChart.update('none'); // 'none' for instant update without animation
}

/* ==========================================
 *  PID SLIDER & INPUT SYNCHRONIZATION
 *  ========================================== */
function initSetpointControls() {
  // Kp Slider
  if (dom.KpSlider) {
    dom.KpSlider.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      if (!isNaN(val) && val >= 0 && val <= 2) {
        dom.KpValue.textContent = val.toFixed(2);
        if (socket) {
          socket.emit('client:update_pid', { Kp: val });
          // Also update Ki and Kd if only Kp changed (keep existing values)
          socket.emit('client:update_pid', { Ki: currentKi, Kd: currentKd });
        }
      }
    });
  }

  // Ki Slider
  if (dom.KiSlider) {
    dom.KiSlider.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      if (!isNaN(val) && val >= 0 && val <= 0.2) {
        dom.KiValue.textContent = val.toFixed(4);
        if (socket) {
          socket.emit('client:update_pid', { Ki: val, Kp: currentKp, Kd: currentKd });
        }
      }
    });
  }

  // Kd Slider
  if (dom.KdSlider) {
    dom.KdSlider.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      if (!isNaN(val) && val >= 0 && val <= 1) {
        dom.KdValue.textContent = val.toFixed(2);
        if (socket) {
          socket.emit('client:update_pid', { Kd: val, Kp: currentKp, Ki: currentKi });
        }
      }
    });
  }
}

/* ==========================================
 *  SETPOINT INPUT SYNCHRONIZATION
 *  ========================================== */
function initSetpointInput() {
  if (dom.setpointSlider && dom.setpointInput) {
    dom.setpointSlider.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      if (!isNaN(val) && val >= 0 && val <= 100) {
        dom.setpointInput.value = val;
        if (socket) socket.emit('client:update_setpoint', val);
      }
    });

    dom.setpointInput.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      if (!isNaN(val) && val >= 0 && val <= 100) {
        dom.setpointSlider.value = val;
        if (socket) socket.emit('client:update_setpoint', val);
      }
    });
  }
}

/* ==========================================
 *  MANUAL OVERRIDE TOGGLE
 *  ========================================== */
function updateManualOverrideToggle(isManual) {
  isManualOverride = isManual;

  // Update PID mode badge
  if (dom.pidMode) {
    const modeText = isManual ? 'MANUAL' : 'AUTO';
    const modeClass = isManual ? 'badge-amber' : 'badge-cyan';
    dom.pidMode.textContent = modeText;
    dom.pidMode.className = `badge ${modeClass}`;
  }

  // Visual feedback
  if (document.body) {
    if (isManual) document.body.classList.add('manual-mode');
    else document.body.classList.remove('manual-mode');
  }
}

/* ==========================================
 *  JURY DEMO: DISTURBANCE INJECTORS
 *  ========================================== */
function initJuryDemo() {
  if (dom.droughtBtn) {
    dom.droughtBtn.addEventListener('click', () => {
      if (socket) socket.emit('client:disturbance', { type: 'drought' });
    });
  }

  if (dom.rainBtn) {
    dom.rainBtn.addEventListener('click', () => {
      if (socket) socket.emit('client:disturbance', { type: 'rain' });
    });
  }

  if (dom.resetBtn) {
    dom.resetBtn.addEventListener('click', () => {
      if (socket) socket.emit('client:manual_override', { enabled: false, manualPwm: 0 });
      // Also reset simulator via server - we'll just show jury info
      showJuryInfo('System reset requested');
    });
  }
}

/* ==========================================
 *  CONNECTION & UPTIME MANAGEMENT
 *  ========================================== */
function updateConnection(connected) {
  const statusEl = dom.connectionStatus;
  const pingEl = dom.pingDot;
  const statusTextEl = dom.statusText;

  if (!statusEl) return;

  if (connected) {
    statusEl.className = 'connection-status connected';
    pingEl.style.background = 'var(--emerald-normal)';
    pingEl.style.animation = 'ping 2s ease-in-out infinite';
    statusTextEl.textContent = 'LIVE';
    startHeartbeat();
  } else {
    statusEl.className = 'connection-status disconnected';
    pingEl.style.background = 'var(--amber-warning)';
    pingEl.style.animation = 'ping 0.5s ease-in-out infinite';
    statusTextEl.textContent = 'OFFLINE';
    stopHeartbeat();
  }
}

function startHeartbeat() {
  if (dom.heartbeatPulse) {
    dom.heartbeatPulse.style.animation = 'heartbeat 1s ease-in-out infinite';
    dom.heartbeatPulse.style.background = 'var(--emerald-normal)';
  }
}

function stopHeartbeat() {
  if (dom.heartbeatPulse) {
    dom.heartbeatPulse.style.animation = 'none';
    dom.heartbeatPulse.style.background = 'rgba(255,255,255,0.08)';
  }
}

function startUptimeTimer() {
  function updateTimer() {
    const elapsed = Math.floor((Date.now() - pageLoadTime) / 1000);
    const hrs = Math.floor(elapsed / 3600);
    const mins = Math.floor((elapsed % 3600) / 60);
    const secs = elapsed % 60;
    const secDisplay = secs < 10 ? '0' + secs : secs;
    if (dom.uptimeTimer) {
      dom.uptimeTimer.textContent = `${hrs}h ${mins}m ${secs}s`;
    }
  }
  updateTimer();
  setInterval(updateTimer, 1000);
}

/* ==========================================
 *  JURY BADGE MESSAGE
 *  ========================================== */
function showJuryInfo(message) {
  if (dom.juryBadge) {
    const prevText = dom.juryBadge.textContent;
    dom.juryBadge.textContent = message;
    setTimeout(() => {
      if (dom.juryBadge) {
        dom.juryBadge.textContent = prevText || 'SDG 6 & 13 Aligned | Precision Agri-Twin v1.2';
      }
    }, 4000);
  }
}

/* ==========================================
 *  APPLICATION ENTRY POINT
 *  ========================================== */
function mainInit() {
  // Replace Feather icons
  if (typeof feather !== 'undefined') {
    feather.replace();
  }

  // Initialize Chart.js
  initChart();

  // Initialize Socket.io
  connectSocket();

  // Initialize controls
  initSetpointControls();
  initSetpointInput();
  initJuryDemo();

  // Start timers
  startUptimeTimer();
  startHeartbeat();

  console.log('HydroSync SCADA Console - Competition Grade v1.2');
}

// Start when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mainInit);
} else {
  mainInit();
}