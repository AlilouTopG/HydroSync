/* public/app.js - HydroSync SCADA Client */

// Initialize resilient Socket.io connection
const socket = io({
  transports: ['websocket', 'polling'],
  reconnectionAttempts: 10
});

// UI State & Elements
const statusBadge = document.getElementById('connectionStatus') || document.getElementById('status-dot');
const statusText = document.getElementById('statusText') || document.getElementById('conn-status');
const uptimeDisplay = document.getElementById('uptimeTimer') || document.getElementById('uptime-val');

// Telemetry Metric Elements
const vwcEl = document.getElementById('vcwProgress') || document.getElementById('val-vwc');
const pwmEl = document.getElementById('actuatorProgress') || document.getElementById('val-pwm');
const flowEl = document.getElementById('flowProgress') || document.getElementById('val-flow');
const savedEl = document.getElementById('conservationProgress') || document.getElementById('val-saved');

// Log Console Helper
function logEvent(msg) {
  const logList = document.getElementById('logList');
  if (!logList) return;
  const time = new Date().toLocaleTimeString();
  const li = document.createElement('li');
  li.textContent = `[${time}] ${msg}`;
  logList.prepend(li);
  if (logList.children.length > 30) logList.removeChild(logList.lastChild);
}

// Chart.js Setup
let telemetryChart = null;
const chartCanvas = document.getElementById('mainChart') || document.getElementById('telemetryChart');

if (chartCanvas) {
  const ctx = chartCanvas.getContext('2d');
  telemetryChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        {
          label: 'Soil Moisture (%)',
          data: [],
          borderColor: '#00E5FF',
          backgroundColor: 'rgba(0, 229, 255, 0.1)',
          borderWidth: 2,
          fill: true,
          tension: 0.3
        },
        {
          label: 'Setpoint (%)',
          data: [],
          borderColor: '#10B981',
          borderDash: [5, 5],
          borderWidth: 1.5,
          fill: false
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        y: { min: 0, max: 100, grid: { color: 'rgba(255,255,255,0.05)' } },
        x: { grid: { color: 'rgba(255,255,255,0.05)' } }
      },
      plugins: { legend: { labels: { color: '#94A3B8' } } },
      animation: { duration: 0 }
    }
  });
}

// --- Socket Handlers ---
socket.on('connect', () => {
  if (statusBadge) statusBadge.classList.add('online');
  if (statusText) statusText.textContent = 'ONLINE';
  logEvent('System online: Connected to HydroSync telemetry engine.');
});

socket.on('disconnect', () => {
  if (statusBadge) statusBadge.classList.remove('online');
  if (statusText) statusText.textContent = 'OFFLINE';
  logEvent('Connection lost. Attempting reconnection...');
});

socket.on('telemetry', (data) => {
  if (!data) return;

  // Update Metrics
  if (vwcEl) vwcEl.textContent = `${(data.vwc || 0).toFixed(1)}%`;
  if (pwmEl) pwmEl.textContent = `${Math.round(data.pumpDuty || 0)}%`;
  if (flowEl) flowEl.textContent = `${(data.flowRate || 0).toFixed(1)} L/m`;
  if (savedEl) savedEl.textContent = `${Math.round(data.waterSaved || 0)}%`;

  // Update Uptime
  if (uptimeDisplay && data.uptimeSeconds !== undefined) {
    const mins = String(Math.floor(data.uptimeSeconds / 60)).padStart(2, '0');
    const secs = String(data.uptimeSeconds % 60).padStart(2, '0');
    uptimeDisplay.textContent = `00:${mins}:${secs}`;
  }

  // Update Chart (FIFO window max 20 points)
  if (telemetryChart) {
    const timeLabel = new Date().toLocaleTimeString();
    telemetryChart.data.labels.push(timeLabel);
    telemetryChart.data.datasets[0].data.push(data.vwc);
    telemetryChart.data.datasets[1].data.push(data.setpoint || 55);

    if (telemetryChart.data.labels.length > 20) {
      telemetryChart.data.labels.shift();
      telemetryChart.data.datasets[0].data.shift();
      telemetryChart.data.datasets[1].data.shift();
    }
    telemetryChart.update();
  }
});

// --- Button & Slider Controls ---
const droughtBtn = document.getElementById('droughtBtn') || document.getElementById('btn-drought');
if (droughtBtn) {
  droughtBtn.addEventListener('click', () => {
    socket.emit('client:disturbance', 'drought');
    logEvent('Weather Trigger: Severe Drought injected.');
  });
}

const rainBtn = document.getElementById('rainBtn') || document.getElementById('btn-rain');
if (rainBtn) {
  rainBtn.addEventListener('click', () => {
    socket.emit('client:disturbance', 'rain');
    logEvent('Weather Trigger: Heavy Rain injected.');
  });
}

const resetBtn = document.getElementById('resetBtn') || document.getElementById('btn-reset');
if (resetBtn) {
  resetBtn.addEventListener('click', () => {
    socket.emit('client:disturbance', 'drought'); // triggers reset cycle
    socket.emit('client:update_setpoint', 55);
    logEvent('System state restored to baseline.');
  });
}

// PID Sliders
['kp', 'ki', 'kd'].forEach((param) => {
  const slider = document.getElementById(`${param}Slider`) || document.getElementById(`slider-${param}`);
  const readout = document.getElementById(`val-${param}`);
  if (slider) {
    slider.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      if (readout) readout.textContent = val.toFixed(2);
      const update = {};
      update[param] = val;
      socket.emit('client:update_pid', update);
    });
  }
});

// Zone Selection (Field Micro-Plots)
document.querySelectorAll('.zone-card').forEach((card) => {
  card.addEventListener('click', () => {
    document.querySelectorAll('.zone-card').forEach((c) => c.classList.remove('active'));
    card.classList.add('active');
    const zoneId = card.dataset.zone || card.querySelector('.zone-id')?.textContent;
    if (zoneId) {
      socket.emit('client:select_zone', zoneId);
      logEvent(`Active sector changed to: ${zoneId}`);
    }
  });
});