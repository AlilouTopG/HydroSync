/* ==========================================================================

   HydroSync v2.1 Professional — Industrial SCADA Client

   Full Integration: Open-Meteo Satellite, Web Serial USB Edge, 

   ISA 5.1 P&ID Screen, Modbus TCP Mapping, AI MPC & ESG Accounting

   ========================================================================== */

(function () {

  "use strict";



  var FIFO_MAX = 25;

  var CIRC = 502.65;

  var FLOW_MAX = 50;

  var WATER_PRICE = 0.045;



  var socket = null;

  var chart = null;

  var labels = [];

  var vwcSeries = [];

  var spSeries = [];

  var booted = false;

  

  var state = { 

    kp: 2.0, ki: 0.1, kd: 0.5, setpoint: 55.0, 

    manual: false, manualPwm: 0, soilType: "loam", 

    tankCapacity: 200, activeZone: "A1" 

  };



  var isOperatorAuthorized = false;

  var aiLastAlert = 0;

  var lastAudioAlert = 0;

  var lastTelemetry = null;

  var lastModalTrigger = null;



  // 🔌 Web Serial API Variables

  var usbPort = null;

  var usbReader = null;

  var isHardwareMode = false;

  var serialLineBuffer = "";



  // 🗺️ GIS Fleet Map Engine Variables

  var mapInstance = null;

  var FLEET_FARMS = [

    { id: "setif", name: "Sétif High Plains Agro-Hub", region: "Sétif Province", crop: "Durum Wheat & Cereals", area: "520 Hectares", lat: 36.19, lon: 5.41, status: "nominal", defaultVwc: 48.0 },

    { id: "biskra", name: "Ziban Oasis Greenhouse Complex", region: "Biskra Province", crop: "Deglet Nour Dates & Early Tomatoes", area: "340 Hectares", lat: 34.85, lon: 5.73, status: "active", defaultVwc: 64.0 },

    { id: "eloued", name: "Oued Souf Pivot Basin", region: "El Oued Province", crop: "Desert Pivot Tubers (Potatoes)", area: "390 Hectares", lat: 33.37, lon: 6.86, status: "nominal", defaultVwc: 54.0 },

    { id: "mitidja", name: "Mitidja Valley Citrus Orchards", region: "Blida / Algiers Province", crop: "Citrus Fruits & Olive Groves", area: "200 Hectares", lat: 36.56, lon: 2.91, status: "nominal", defaultVwc: 59.0 }

  ];



  // 🧠 Chart Instances

  var horizonChart = null;

  var vibrationChart = null;

  var zoneWaterChart = null;

  var vibLabels = [];

  var vibSeries = [];

  var lastWaveformData = null;



  var CROP_PROFILES = {

    "Wheat": { setpoint: 48.0, kp: 2.2, ki: 0.08, kd: 0.4 },

    "Tomatoes": { setpoint: 65.0, kp: 3.2, ki: 0.16, kd: 0.6 },

    "Olives": { setpoint: 35.0, kp: 1.4, ki: 0.04, kd: 0.3 },

    "Barley": { setpoint: 42.0, kp: 2.0, ki: 0.07, kd: 0.35 },

    "Corn": { setpoint: 60.0, kp: 2.8, ki: 0.12, kd: 0.5 },

    "Potatoes": { setpoint: 55.0, kp: 2.4, ki: 0.10, kd: 0.45 }

  };



  function $(id) { return document.getElementById(id); }



  function numberOr(value, fallback) {

    var n = Number(value);

    return Number.isFinite(n) ? n : fallback;

  }



  function escapeHTML(value) {

    return String(value == null ? "" : value)

      .replace(/&/g, "&amp;")

      .replace(/</g, "&lt;")

      .replace(/>/g, "&gt;")

      .replace(/"/g, "&quot;")

      .replace(/'/g, "&#039;");

  }



  /* ---------- Audio Synthesizer ---------- */

  var audioCtx = null;

  var audioMuted = false;



  function initAudio() {

    if (!audioCtx) {

      var AudioContext = window.AudioContext || window.webkitAudioContext;

      if (AudioContext) audioCtx = new AudioContext();

    }

    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();

  }



  function playTone(freq, type, duration, vol) {

    if (audioMuted || !audioCtx) return;

    try {

      var osc = audioCtx.createOscillator();

      var gain = audioCtx.createGain();

      osc.type = type || 'sine';

      osc.frequency.setValueAtTime(freq, audioCtx.currentTime);

      gain.gain.setValueAtTime(vol || 0.1, audioCtx.currentTime);

      gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + duration);

      osc.connect(gain);

      gain.connect(audioCtx.destination);

      osc.start();

      osc.stop(audioCtx.currentTime + duration);

    } catch (e) {}

  }



  function playEmergencySiren() {

    if (audioMuted) return;

    initAudio();

    playTone(880, 'sawtooth', 0.25, 0.12);

    setTimeout(function () { playTone(587, 'sawtooth', 0.35, 0.12); }, 260);

  }



  function playCautionBeep() {

    if (audioMuted) return;

    initAudio();

    playTone(659, 'sine', 0.15, 0.08);

  }



  function playClick() {

    if (audioMuted) return;

    initAudio();

    playTone(1200, 'triangle', 0.04, 0.05);

  }



  function log(msg) {

    try {

      var list = $("logList");

      if (!list) return;

      var li = document.createElement("li");

      var t = new Date().toLocaleTimeString("en-GB", { hour12: false });

      var time = document.createElement("span");

      time.className = "t";

      time.textContent = t;

      li.appendChild(time);

      var contentSpan = document.createElement("span");

      contentSpan.innerHTML = " " + msg;

      li.appendChild(contentSpan);

      list.prepend(li);

      while (list.children.length > 30) list.removeChild(list.lastChild);

      var count = $("logCount");

      if (count) count.textContent = list.children.length + " events";

    } catch (e) {}

  }



  function fmtUptime(total) {

    total = Math.max(0, Math.floor(total || 0));

    var h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;

    function p(n) { return (n < 10 ? "0" : "") + n; }

    return p(h) + ":" + p(m) + ":" + p(s);

  }



  function setStatus(online) {

    var badge = $("connectionStatus"), txt = $("statusText");

    if (!badge || !txt) return;

    var isOnline = !!online;

    badge.classList.toggle("online", isOnline);

    badge.classList.toggle("offline", !isOnline);

    txt.textContent = isOnline ? "ONLINE" : "OFFLINE";

  }



  function setRing(id, frac) {

    var el = $(id);

    if (!el) return;

    frac = Math.max(0, Math.min(1, frac || 0));

    el.style.strokeDashoffset = String(CIRC - CIRC * frac);

  }



  function setText(id, text) {

    var el = $(id);

    if (el) el.textContent = text == null ? "" : String(text);

  }



  // Use only for trusted, locally constructed markup.

  function setHTML(id, html) {

    var el = $(id);

    if (el) el.innerHTML = html == null ? "" : String(html);

  }



  /* ---------- Chart Setup ---------- */

  function initChart() {

    var canvas = $("mainChart");

    if (!canvas || typeof Chart === "undefined") return;

    var ctx = canvas.getContext("2d");

    if (!ctx) return;

    var grad = ctx.createLinearGradient(0, 0, 0, 340);

    grad.addColorStop(0, "rgba(0,229,255,0.35)");

    grad.addColorStop(1, "rgba(0,229,255,0.02)");

    chart = new Chart(ctx, {

      type: "line",

      data: { labels: [], datasets: [

        { label: "Soil Moisture %", data: [], borderColor: "#00E5FF", backgroundColor: grad,

          fill: true, tension: 0.45, pointRadius: 0, pointHoverRadius: 4, borderWidth: 2.5 },

        { label: "Target %", data: [], borderColor: "#F59E0B", borderDash: [8, 6],

          fill: false, tension: 0, pointRadius: 0, borderWidth: 1.8 }

      ]},

      options: {

        responsive: true, maintainAspectRatio: false,

        animation: { duration: 0 },

        interaction: { intersect: false, mode: "index" },

        scales: {

          y: { min: 0, max: 100,

            ticks: { color: "rgba(232,238,247,.55)", font: { family: "JetBrains Mono", size: 10 } },

            grid: { color: "rgba(255,255,255,.06)" } },

          x: { ticks: { color: "rgba(139,152,179,.8)", font: { family: "JetBrains Mono", size: 9 }, maxTicksLimit: 8 },

            grid: { color: "rgba(255,255,255,.04)" } }

        },

        plugins: { legend: { labels: { color: "rgba(232,238,247,.7)", font: { size: 11 }, boxWidth: 18 } } }

      }

    });

  }



  function pushPoint(vwc, sp) {

    if (!chart) return;

    var now = new Date().toLocaleTimeString("en-GB", { hour12: false });

    labels.push(now); vwcSeries.push(vwc); spSeries.push(sp);

    while (labels.length > FIFO_MAX) { labels.shift(); vwcSeries.shift(); spSeries.shift(); }

    chart.data.labels = labels;

    chart.data.datasets[0].data = vwcSeries;

    chart.data.datasets[1].data = spSeries;

    chart.update("none");

  }



  function seedChart(vwc, sp) {

    labels = []; vwcSeries = []; spSeries = [];

    var t = Date.now();

    for (var i = FIFO_MAX - 1; i >= 0; i--) {

      var d = new Date(t - i * 1000).toLocaleTimeString("en-GB", { hour12: false });

      labels.push(d);

      vwcSeries.push(Math.max(0, Math.min(100, vwc + (Math.random() - 0.5) * 2)));

      spSeries.push(sp);

    }

    if (chart) {

      chart.data.labels = labels;

      chart.data.datasets[0].data = vwcSeries;

      chart.data.datasets[1].data = spSeries;

      chart.update("none");

    }

  }



  /* ---------- Telemetry Dispatcher ---------- */

  function onTelemetry(d) {

    if (!d || typeof d !== "object") return;

    var previous = lastTelemetry || {};

    var vwc = numberOr(d.vwc, numberOr(previous.vwc, 0));

    var sp = numberOr(d.setpoint, numberOr(previous.setpoint, state.setpoint));

    var pwm = numberOr(d.pumpDuty, numberOr(previous.pwm, 0));

    var flow = numberOr(d.flowRate, numberOr(previous.flow, 0));

    var saved = numberOr(d.waterSaved, numberOr(previous.saved, 0));

    var err = numberOr(d.error, sp - vwc);

    var mTemp = numberOr(d.motorTemp, numberOr(previous.motorTemp, 24.0));

    lastTelemetry = { vwc: vwc, setpoint: sp, pwm: pwm, flow: flow, saved: saved, motorTemp: mTemp };



    setText("uptimeTimer", fmtUptime(d.uptimeSeconds));

    setText("vcwValue", vwc.toFixed(1));

    setText("vcwValueDisplay", vwc.toFixed(1) + "%");

    setText("vcwSetpointDisplay", "Target: " + sp.toFixed(1) + "%");

    setRing("vcwProgress", vwc / 100);



    setText("actuatorValue", String(Math.round(pwm)));

    setText("actuatorValueDisplay", Math.round(pwm) + "%");

    setRing("actuatorProgress", pwm / 100);



    setText("flowValue", flow.toFixed(1));

    setText("flowValueDisplay", flow.toFixed(1) + " L/min");

    setRing("flowProgress", flow / FLOW_MAX);



    setText("conservationValue", String(Math.round(saved)));

    setText("conservationValueDisplay", Math.round(saved) + "%");

    setRing("conservationProgress", saved / 100);

    

    var litersSaved = (typeof d.waterSavedL === "number") ? d.waterSavedL : 0;

    var moneySaved = (litersSaved * WATER_PRICE).toFixed(3);

    setHTML("savedLitersValue", litersSaved.toFixed(1) + " L <span style='color:var(--ok); margin-left:6px;'><i class='fa-solid fa-sack-dollar'></i> $" + moneySaved + "</span>");

    

    setText("errorValue", "e(t) " + (err >= 0 ? "+" : "") + err.toFixed(1));

    setText("KpTerm", (+d.pTerm || 0).toFixed(2));

    setText("KiTerm", (+d.iTerm || 0).toFixed(2));

    setText("KdTerm", (+d.dTerm || 0).toFixed(2));



    setText("motorTempVal", mTemp.toFixed(1) + "°C");

    updateSafetyStatus(d);



    if (d.threatsBlocked !== undefined) {

      setText("threatsBlockedVal", d.threatsBlocked + " Blocked");

    }



    // 🛰️ Real Satellite Climate Rendering

    if (d.liveWeather) {

      var realTemp = (typeof d.liveWeather.temp === "number") ? d.liveWeather.temp.toFixed(1) : "--";

      var realWind = (typeof d.liveWeather.windSpeed === "number") ? d.liveWeather.windSpeed.toFixed(1) : "--";

      var realHumidity = (typeof d.liveWeather.humidity === "number") ? Math.round(d.liveWeather.humidity) : "--";

      var realET0 = (typeof d.liveWeather.et0 === "number") ? d.liveWeather.et0.toFixed(2) : "--";



      setText("wTemp", realTemp + " °C");

      setText("wWind", realWind + " km/h");

      setText("wHumidity", realHumidity + " %");

      setText("wET0", realET0 + " mm/d");

      setText("tempValue", realTemp + " °C");

      setText("et0Value", "ET0 " + realET0 + " mm/day");



      var code = d.liveWeather.weatherCode;

      var condEl = $("wCondition");

      if (condEl) {

        if (code === 0) condEl.innerHTML = "<i class='fa-solid fa-sun' style='color:#F59E0B'></i> Clear Sky";

        else if (code >= 1 && code <= 3) condEl.innerHTML = "<i class='fa-solid fa-cloud-sun' style='color:#00E5FF'></i> Partly Cloudy";

        else if (code >= 51 && code <= 67) condEl.innerHTML = "<i class='fa-solid fa-cloud-rain' style='color:#00E5FF'></i> Rain Inflow";

        else if (code >= 80 && code <= 82) condEl.innerHTML = "<i class='fa-solid fa-cloud-showers-heavy' style='color:#3B82F6'></i> Showers";

        else condEl.innerHTML = "<i class='fa-solid fa-cloud' style='color:#94A3B8'></i> Overcast";

      }

    }



    if (d.predictiveAI) updatePredictiveUI(d.predictiveAI);

    if (d.assetHealth) updateHealthUI(d.assetHealth, mTemp);



    // 📊 DSP Waveform & FFT Live Update (Optimized for active view)

    var waveformSource = (d.assetHealth && d.assetHealth.vibrationWaveform) ? d.assetHealth.vibrationWaveform : d.vibrationWaveform;

    if (waveformSource) {

      lastWaveformData = waveformSource;

      var healthView = $("viewHealth");

      var isHealthVisible = healthView && !healthView.hidden;



      if (window.HydroSyncCharts && isHealthVisible) {

        HydroSyncCharts.updateWaveformChart(waveformSource);

        var fftMagnitudes = HydroSyncCharts.computeFFT(waveformSource);

        HydroSyncCharts.updateFFTChart(fftMagnitudes);

      }

    }



    if (d.esgMetrics && Array.isArray(d.zones)) updateAnalyticsUI(d.esgMetrics, d.zones, litersSaved);



    if (typeof d.tankCapacityL === "number") state.tankCapacity = d.tankCapacityL;

    if (typeof d.soilType === "string") state.soilType = d.soilType;

    

    updateTwin(vwc, pwm, flow, d);

    updatePidSchematic(vwc, pwm, flow, d);

    updateModbusTable(vwc, sp, pwm, flow, mTemp, d);

    renderZones(d.zones, d.activeZoneId);

    runAIAnalyst(vwc, sp, pwm, flow);



    if (!booted) {

      booted = true;

      state.setpoint = sp;

      if (typeof d.kp === "number") state.kp = d.kp;

      if (typeof d.ki === "number") state.ki = d.ki;

      if (typeof d.kd === "number") state.kd = d.kd;

      syncControls();

      syncSettingsForm();

      seedChart(vwc, sp);

      log("<strong style='color:var(--ok)'>[SYSTEM]</strong> SCADA Core linked. ISA 5.1 &amp; Modbus mapping active.");

    } else {

      pushPoint(vwc, sp);

    }

  }



  function updateSafetyStatus(d) {

    var banner = $("safetyBanner");

    var title = $("safetyTitle");

    var desc = $("safetyDesc");

    var icon = $("safetyIcon");

    var interlockVal = $("interlockVal");

    var now = Date.now();



    var faults = Array.isArray(d.activeFaults) ? d.activeFaults : [];

    if (interlockVal) interlockVal.textContent = faults.length + " Active";

    if (!banner) return;



    banner.classList.remove("nominal", "degraded", "emergency");



    if (d.systemHealth === 'EMERGENCY_LOCK' || (d.safety && d.safety.tripped)) {

      banner.classList.add("emergency");

      if (icon) icon.className = "fa-solid fa-triangle-exclamation";

      if (title) title.textContent = "EMERGENCY INTERLOCK ENGAGED";

      if (desc) desc.textContent = faults.length ? faults[0] : (d.safety && d.safety.alarms ? d.safety.alarms[0] : "Critical threshold tripped. Pump isolated.");

      if (now - lastAudioAlert > 3500) { playEmergencySiren(); lastAudioAlert = now; }

    } else if (d.systemHealth === 'DEGRADED') {

      banner.classList.add("degraded");

      if (icon) icon.className = "fa-solid fa-circle-exclamation";

      if (title) title.textContent = "DEGRADED: THERMAL DERATING";

      if (desc) desc.textContent = faults.length ? faults[0] : "Motor temp > 85°C. Duty clamped to 30%.";

      if (now - lastAudioAlert > 5000) { playCautionBeep(); lastAudioAlert = now; }

    } else {

      banner.classList.add("nominal");

      if (icon) icon.className = "fa-solid fa-shield-halved";

      if (title) title.textContent = "ALL SYSTEMS NOMINAL";

      if (desc) desc.textContent = "IEC 61508 Functional Safety Loops Active — No Hardware Faults.";

    }

  }



  function runAIAnalyst(vwc, sp, pwm, flow) {

    var now = Date.now();

    if (now - aiLastAlert > 20000) {

      if (pwm > 85 && vwc < sp - 15) {

        log("<strong style='color:var(--brand)'><i class='fa-solid fa-robot'></i> [AI CO-PILOT]</strong> High output with low response in Sector " + state.activeZone + ". Leak check advised.");

        aiLastAlert = now;

      }

    }

  }



  function updateTwin(vwc, pwm, flow, d) {

    try {

      var pct, liters;

      if (d && typeof d.tankVolumeL === "number" && typeof d.tankCapacityL === "number" && d.tankCapacityL > 0) {

        pct = Math.max(0, Math.min(100, (d.tankVolumeL / d.tankCapacityL) * 100));

        liters = d.tankVolumeL;

      } else {

        pct = 85; liters = 170;

      }



      var fill = $("twinTankFill");

      if (fill) fill.style.height = pct.toFixed(1) + "%";

      setText("twinTankLevel", Math.round(pct) + "% · " + liters.toFixed(0) + "L");

      

      var pipe = $("twinPipe");

      if (pipe) {

        var flowing = pwm > 0.5;

        pipe.classList.toggle("flowing", flowing);

        pipe.style.setProperty("--flow-speed", (2.2 - (Math.min(100, pwm) / 100) * 1.7).toFixed(2) + "s");

      }

      setText("twinPwmLabel", Math.round(pwm) + "% PWM");

      

      var soil = $("twinSoil");

      if (soil) {

        soil.classList.toggle("dry", vwc < 30);

        soil.classList.toggle("wet", vwc > 65);

      }

      setText("twinStatus", vwc < 30 ? "DRY — IRRIGATING" : vwc > 65 ? "SATURATED" : "HYDRATED");

    } catch (e) {}

  }



  /* ---------- 📐 ISA 5.1 P&ID Vector Scheme Update ---------- */

  function updatePidSchematic(vwc, pwm, flow, d) {

    try {

      var isRunning = pwm > 0.5;

      var line1 = $("pidLine1");

      var line2 = $("pidLine2");

      var pumpBody = $("pidPumpBody");



      if (line1) line1.classList.toggle("active-flow", isRunning);

      if (line2) line2.classList.toggle("active-flow", isRunning);

      if (pumpBody) pumpBody.classList.toggle("running", isRunning);



      var pct = (d && typeof d.tankVolumePct === "number") ? d.tankVolumePct : 85;

      var tankRect = $("pidTankFillRect");

      if (tankRect) {

        var h = Math.max(5, Math.min(146, (pct / 100) * 146));

        tankRect.setAttribute("height", h.toFixed(0));

        tankRect.setAttribute("y", (208 - h).toFixed(0));

      }



      var pressureBar = (1.2 + (pwm / 100) * 2.6).toFixed(1);

      setText("pidTankVal", Math.round(pct) + "%");

      setText("pidPumpPwmTag", Math.round(pwm) + "% PWM");

      setText("pidFtVal", flow.toFixed(1) + " L/m");

      setText("pidPtVal", pressureBar + " bar");

      setText("pidSoilVal", vwc.toFixed(1) + "% VWC");



      setHTML("pidKpiPressure", pressureBar + " <small>bar</small>");

      setHTML("pidKpiFlow", flow.toFixed(1) + " <small>L/min</small>");

      setText("pidKpiValve", isRunning ? "OPEN" : "CLOSED");



      var xvTag = $("pidXvState");

      if (xvTag) {

        xvTag.textContent = isRunning ? "XV-101 [OPEN]" : "XV-101 [CLOSED]";

      }

    } catch (e) {}

  }



  /* ---------- 🔌 Modbus TCP Table Live Update ---------- */

  function updateModbusTable(vwc, sp, pwm, flow, mTemp, d) {

    var tbody = $("modbusTableBody");

    if (!tbody) return;



    var ah = d && d.assetHealth ? d.assetHealth : { vibrationRms: 0.22, healthIndex: 98.4 };

    var isEmergency = d && (d.systemHealth === 'EMERGENCY_LOCK' || (d.safety && d.safety.tripped));



    var registers = [

      { reg: "00001", type: "Coil (0x)", tag: "P-101 Command", raw: pwm > 0 ? "0x01" : "0x00", val: pwm > 0 ? "RUNNING (1)" : "STOPPED (0)" },

      { reg: "00002", type: "Coil (0x)", tag: "Control Mode", raw: state.manual ? "0x01" : "0x00", val: state.manual ? "MANUAL (1)" : "AUTO (0)" },

      { reg: "00003", type: "Coil (0x)", tag: "Emergency Interlock", raw: isEmergency ? "0x01" : "0x00", val: isEmergency ? "TRIPPED (1)" : "NORMAL (0)" },

      { reg: "00004", type: "Coil (0x)", tag: "XV-101 Solenoid", raw: pwm > 0 ? "0x01" : "0x00", val: pwm > 0 ? "OPEN (1)" : "CLOSED (0)" },

      { reg: "40001", type: "Holding (4x)", tag: "MT-101 Soil VWC", raw: "0x" + Math.round(vwc * 10).toString(16).toUpperCase().padStart(4, "0"), val: vwc.toFixed(1) + " %" },

      { reg: "40002", type: "Holding (4x)", tag: "Target Setpoint SP", raw: "0x" + Math.round(sp * 10).toString(16).toUpperCase().padStart(4, "0"), val: sp.toFixed(1) + " %" },

      { reg: "40003", type: "Holding (4x)", tag: "P-101 PWM Duty", raw: "0x" + Math.round(pwm).toString(16).toUpperCase().padStart(4, "0"), val: Math.round(pwm) + " %" },

      { reg: "40004", type: "Holding (4x)", tag: "FT-101 Flow Rate", raw: "0x" + Math.round(flow * 10).toString(16).toUpperCase().padStart(4, "0"), val: flow.toFixed(1) + " L/min" },

      { reg: "40005", type: "Holding (4x)", tag: "LT-101 Tank Level", raw: "0x" + Math.round(d && d.tankVolumePct ? d.tankVolumePct : 85).toString(16).toUpperCase().padStart(4, "0"), val: (d && d.tankVolumePct ? d.tankVolumePct : 85).toFixed(0) + " %" },

      { reg: "40006", type: "Holding (4x)", tag: "TT-101 Motor Stator", raw: "0x" + Math.round(mTemp * 10).toString(16).toUpperCase().padStart(4, "0"), val: mTemp.toFixed(1) + " °C" },

      { reg: "40007", type: "Holding (4x)", tag: "ISO 10816 Vibration", raw: "0x" + Math.round(ah.vibrationRms * 100).toString(16).toUpperCase().padStart(4, "0"), val: ah.vibrationRms.toFixed(2) + " mm/s" }

    ];



    var html = "";

    for (var i = 0; i < registers.length; i++) {

      var r = registers[i];

      html += "<tr>" +

        "<td style='color:var(--brand); font-weight:700;'>" + r.reg + "</td>" +

        "<td style='color:var(--text-dim);'>" + r.type + "</td>" +

        "<td>" + r.tag + "</td>" +

        "<td style='color:#38BDF8; font-weight:600;'>" + r.raw + "</td>" +

        "<td style='color:var(--ok); font-weight:600;'>" + r.val + "</td>" +

        "</tr>";

    }

    tbody.innerHTML = html;

  }



  function zoneBand(m) {

    if (m < 35) return "dry";

    if (m > 65) return "wet";

    return "optimal";

  }



  function renderZones(zones, activeId) {

    try {

      if (!Array.isArray(zones) || !zones.length) return;

      if (typeof activeId === "string") state.activeZone = activeId;

      for (var i = 0; i < zones.length; i++) {

        (function (z) {

          if (!z || typeof z.id !== "string") return;

          var card = document.querySelector('#zonesContainer [data-zone="' + z.id + '"]');

          if (!card) return;

          var m = Math.max(0, Math.min(100, +z.moisture || 0));

          var val = card.querySelector(".zone-val");

          if (val) val.textContent = Math.round(m) + "%";

          card.classList.remove("dry", "optimal", "wet");

          card.classList.add(zoneBand(m));

          card.classList.toggle("active", z.id === state.activeZone);

          card.setAttribute("aria-pressed", String(z.id === state.activeZone));

        })(zones[i]);

      }

      setText("activeZoneBadge", "Active: Zone " + state.activeZone);

    } catch (e) {}

  }



  function syncControls() {

    var kp = $("KpSlider"), ki = $("KiSlider"), kd = $("KdSlider"), sp = $("setpointSlider");

    if (kp) kp.value = state.kp;

    if (ki) ki.value = state.ki;

    if (kd) kd.value = state.kd;

    if (sp) sp.value = state.setpoint;

    setText("KpValue", state.kp.toFixed(2));

    setText("KiValue", state.ki.toFixed(4));

    setText("KdValue", state.kd.toFixed(2));

    setText("setpointValue", state.setpoint.toFixed(1) + "%");

  }



  function emitPid() {

    if (!socket || !socket.connected) return;

    socket.emit("client:update_pid", { kp: state.kp, ki: state.ki, kd: state.kd });

  }



  function pressFlash(el) {

    if (!el) return;

    el.classList.add("firing");

    setTimeout(function () { el.classList.remove("firing"); }, 320);

  }



  function setManualUI(manual) {

    setText("modeLabel", manual ? "MANUAL" : "AUTO");

    setText("pidMode", manual ? "MANUAL" : "AUTO");

    var row = $("manualRow"); if (row) row.hidden = !manual;

    var banner = $("manualBanner"); if (banner) banner.hidden = !manual;

    var pidCard = document.querySelector(".pid-card");

    if (pidCard) pidCard.classList.toggle("manual-active", manual);

  }



  /* ==========================================================================

   *  🔌 WEB SERIAL API ENGINE

   * ========================================================================== */

  async function connectUSBHardware() {

    if (!("serial" in navigator)) {

      alert("Web Serial API is not supported in this browser. Please use Chrome or Edge.");

      return;

    }



    try {

      usbPort = await navigator.serial.requestPort();

      await usbPort.open({ baudRate: 115200 });



      var linkBtn = $("usbConnectBtn");

      var statusChip = $("usbStatusChip");

      var statusText = $("usbStatusText");



      if (linkBtn) linkBtn.hidden = true;

      if (statusChip) statusChip.hidden = false;

      if (statusText) statusText.textContent = "USB Connected (115200)";



      log("<strong style='color:var(--ok)'><i class='fa-brands fa-usb'></i> [USB HW]</strong> Serial COM Port linked successfully at 115200 baud.");

      playTone(1000, 'sine', 0.2, 0.1);



      readUSBStream();

    } catch (err) {

      log("<strong style='color:var(--crit)'>[USB ERROR]</strong> Failed to open COM port: " + err.message);

    }

  }



  async function readUSBStream() {

    var textDecoder = new TextDecoderStream();

    usbPort.readable.pipeTo(textDecoder.writable);

    var reader = textDecoder.readable.getReader();

    usbReader = reader;



    try {

      while (true) {

        var result = await reader.read();

        if (result.done) break;

        if (result.value) {

          serialLineBuffer += result.value;

          var lines = serialLineBuffer.split("\n");

          serialLineBuffer = lines.pop();



          for (var i = 0; i < lines.length; i++) {

            var line = lines[i].trim();

            if (line.startsWith("{") && line.endsWith("}")) {

              parseHardwarePacket(line);

            }

          }

        }

      }

    } catch (error) {

      log("<strong style='color:var(--crit)'>[USB DISCONNECT]</strong> Hardware link terminated.");

    } finally {

      reader.releaseLock();

    }

  }



  function parseHardwarePacket(jsonStr) {

    try {

      var hw = JSON.parse(jsonStr);

      if (isHardwareMode) {

        onTelemetry({

          ...hw,

          systemHealth: hw.systemHealth || 'NOMINAL',

          uptimeSeconds: Math.floor(performance.now() / 1000)

        });

      }

    } catch (e) {}

  }



  async function writeToUSB(commandString) {

    if (!usbPort || !usbPort.writable) return;

    try {

      var encoder = new TextEncoder();

      var writer = usbPort.writable.getWriter();

      await writer.write(encoder.encode(commandString + "\n"));

      writer.releaseLock();

    } catch (e) {}

  }



  /* ==========================================================================

   *  🗺️ MULTI-VIEW NAVIGATION ENGINE

   * ========================================================================== */

  function switchView(viewName) {

    var dashView = $("viewDashboard");

    var fleetView = $("viewFleet");

    var predView = $("viewPredictive");

    var healthView = $("viewHealth");

    var analyticsView = $("viewAnalytics");

    var pidView = $("viewPid");

    var navLinks = document.querySelectorAll(".sidebar-nav .nav-item[data-view]");



    Array.prototype.forEach.call(navLinks, function (btn) {

      btn.classList.toggle("active", btn.getAttribute("data-view") === viewName);

    });



    if (dashView) dashView.hidden = (viewName !== "dashboard");

    if (fleetView) fleetView.hidden = (viewName !== "fleet");

    if (predView) predView.hidden = (viewName !== "predictive");

    if (healthView) healthView.hidden = (viewName !== "health");

    if (analyticsView) analyticsView.hidden = (viewName !== "analytics");

    if (pidView) pidView.hidden = (viewName !== "pidView");



    if (viewName === "fleet") {

      setTimeout(function () { initFleetMap(); }, 150);

      log("<strong style='color:var(--brand)'><i class='fa-solid fa-map-location-dot'></i> [GIS FLEET]</strong> Switched to National Satellite Fleet Overview.");

    } else if (viewName === "predictive") {

      setTimeout(function () { if (horizonChart) horizonChart.resize(); }, 150);

      log("<strong style='color:var(--brand)'><i class='fa-solid fa-brain'></i> [PREDICTIVE AI]</strong> Switched to Model Predictive Control (MPC) Climate Horizon.");

    } else if (viewName === "health") {

      setTimeout(function () { 

        if (!vibrationChart) initVibrationChart();

        else vibrationChart.resize(); 



        // تهيئة دقيقة للرسوم اللحظية بمجرد ظهور حاوية الـ Canvas

        if (window.HydroSyncCharts) {

          HydroSyncCharts.initWaveformChart('vibrationWaveformChart');

          HydroSyncCharts.initFFTChart('vibrationFFTChart');

          if (lastWaveformData) {

            HydroSyncCharts.updateWaveformChart(lastWaveformData);

            HydroSyncCharts.updateFFTChart(HydroSyncCharts.computeFFT(lastWaveformData));

          }

        }

      }, 150);

      log("<strong style='color:var(--ok)'><i class='fa-solid fa-screwdriver-wrench'></i> [ASSET HEALTH]</strong> Switched to ISO 10816 Mechanical Diagnostics Console.");

    } else if (viewName === "analytics") {

      setTimeout(function () {

        if (zoneWaterChart) zoneWaterChart.resize();

      }, 150);

      log("<strong style='color:var(--ok)'><i class='fa-solid fa-chart-pie'></i> [ANALYTICS]</strong> Switched to Agronomic Accounting & ESG Impact Console.");

    } else if (viewName === "pidView") {

      log("<strong style='color:var(--brand)'><i class='fa-solid fa-diagram-project'></i> [P&amp;ID PROCESS]</strong> Switched to ISA 5.1 &amp; Modbus TCP Live Register Overview.");

    }

  }



  function initFleetMap() {

    if (mapInstance) {

      setTimeout(function () { mapInstance.invalidateSize(); }, 200);

      return;

    }



    var mapContainer = $("fleetMap");

    if (!mapContainer || typeof L === "undefined") return;



    mapInstance = L.map("fleetMap", {

      center: [34.9, 5.0],

      zoom: 6.2,

      zoomControl: true,

      attributionControl: false

    });



    var satelliteTiles = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", { maxZoom: 18 });

    var darkTiles = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}", { maxZoom: 18 });



    satelliteTiles.addTo(mapInstance);



    L.control.layers({

      "🛰️ Satellite Imagery": satelliteTiles,

      "🌑 Cyber Dark Canvas": darkTiles

    }, null, { position: "topright" }).addTo(mapInstance);



    FLEET_FARMS.forEach(function (farm) {

      var isIrrigating = farm.status === "active";

      var color = isIrrigating ? "#00E5FF" : "#10B981";



      var marker = L.circleMarker([farm.lat, farm.lon], {

        radius: 11,

        fillColor: color,

        color: "#FFFFFF",

        weight: 2.5,

        opacity: 1,

        fillOpacity: 0.85

      }).addTo(mapInstance);



      var popupHtml = "<div style='padding:4px; font-size:12px; font-family:var(--sans);'>" +

        "<strong style='color:#00E5FF; font-size:13px; display:block; margin-bottom:4px;'>" + farm.name + "</strong>" +

        "<span>Region: " + farm.region + "</span><br/>" +

        "<span>Crop: " + farm.crop + " (" + farm.area + ")</span><br/>" +

        "<span style='color:" + color + "; font-weight:700;'>Status: " + (isIrrigating ? "IRRIGATION ACTIVE" : "NOMINAL IDLE") + "</span>" +

        "</div>";



      marker.bindPopup(popupHtml);

      marker.on("click", function () { selectFarmHub(farm); });

    });



    setTimeout(function () { if (mapInstance) mapInstance.invalidateSize(); }, 250);

  }



  function selectFarmHub(farm) {

    setText("focusFarmName", farm.name);

    setText("focusCrop", farm.crop);

    setText("focusArea", farm.area);

    setText("focusVwc", farm.defaultVwc.toFixed(1) + "%");



    if (socket && socket.connected) socket.emit("client:set_location", farm.id);

    var locSelect = $("locationSelect");

    if (locSelect) locSelect.value = farm.id;



    log("<strong style='color:var(--ok)'><i class='fa-solid fa-satellite'></i> [FLEET FOCUS]</strong> Linked SCADA to <strong>" + farm.name + "</strong>");

  }



  /* ==========================================================================

   *  🧠 PREDICTIVE AI (MPC) HORIZON RENDERER

   * ========================================================================== */

  function updatePredictiveUI(p) {

    if (!p) return;



    var decEl = $("aiDecisionKpi");

    if (decEl) {

      decEl.textContent = p.rainHoldActive ? "AUTONOMOUS RAIN HOLD" : "NOMINAL DISPATCH";

      decEl.className = "kpi-val " + (p.rainHoldActive ? "hold-active" : "nominal");

    }



    setText("aiConfidenceKpi", (p.confidence || 92) + "%");

    setText("aiRainPeakKpi", (p.maxRainProb12h || 0) + "%");

    setText("aiSavingsKpi", (p.waterSavedEstimateL || 0) + " L");



    setText("aiForecastStatus", p.rainHoldActive ? "Impending Precipitation Front" : "Stable Micro-Climate Horizon");

    setText("aiActionRecommend", p.rainHoldActive ? "Hold Irrigation (Anticipate Rain)" : "Standard Closed-Loop Dispatch");

    setText("aiRainVolExpected", (p.totalRain24h || 0).toFixed(1) + " mm");



    var holdBadge = $("aiHoldStateBadge");

    if (holdBadge) {

      holdBadge.textContent = p.rainHoldActive ? "ACTIVE (HELD)" : "INACTIVE";

      holdBadge.className = p.rainHoldActive ? "active" : "inactive";

    }



    setText("aiRationaleText", p.rationale || "Micro-climate telemetry nominal.");



    if (Array.isArray(p.horizon) && p.horizon.length) {

      renderHorizonChart(p.horizon);

    }

  }



  function renderHorizonChart(horizon) {

    var canvas = $("horizonChart");

    if (!canvas || typeof Chart === "undefined") return;



    var hLabels = horizon.map(function (h) { return h.hour; });

    var probData = horizon.map(function (h) { return h.prob; });

    var rainData = horizon.map(function (h) { return h.rainMm; });

    var tempData = horizon.map(function (h) { return h.temp; });



    if (!horizonChart) {

      var ctx = canvas.getContext("2d");

      if (!ctx) return;

      horizonChart = new Chart(ctx, {

        data: {

          labels: hLabels,

          datasets: [

            { type: "line", label: "Rain Probability (%)", data: probData, borderColor: "#00E5FF", backgroundColor: "rgba(0, 229, 255, 0.12)", fill: true, tension: 0.4, yAxisID: "y", borderWidth: 2.5, pointRadius: 2 },

            { type: "bar", label: "Precipitation (mm)", data: rainData, backgroundColor: "rgba(56, 189, 248, 0.65)", borderColor: "#38BDF8", borderWidth: 1, yAxisID: "y1", borderRadius: 4 },

            { type: "line", label: "Air Temp (°C)", data: tempData, borderColor: "#F59E0B", borderDash: [4, 4], fill: false, tension: 0.3, yAxisID: "y", borderWidth: 1.8, pointRadius: 0 }

          ]

        },

        options: {

          responsive: true, maintainAspectRatio: false, animation: { duration: 0 },

          scales: {

            y: { min: 0, max: 100, position: "left", ticks: { color: "rgba(232,238,247,.55)", font: { family: "JetBrains Mono", size: 10 } }, grid: { color: "rgba(255,255,255,.05)" } },

            y1: { min: 0, max: Math.max(10, Math.ceil(Math.max.apply(null, rainData.concat([0])) * 1.5)), position: "right", ticks: { color: "#38BDF8", font: { family: "JetBrains Mono", size: 10 } }, grid: { drawOnChartArea: false } },

            x: { ticks: { color: "rgba(139,152,179,.8)", font: { family: "JetBrains Mono", size: 9 }, maxTicksLimit: 12 }, grid: { color: "rgba(255,255,255,.04)" } }

          },

          plugins: { legend: { labels: { color: "rgba(232,238,247,.75)", font: { size: 11 }, boxWidth: 14 } } }

        }

      });

    } else {

      horizonChart.data.labels = hLabels;

      horizonChart.data.datasets[0].data = probData;

      horizonChart.data.datasets[1].data = rainData;

      horizonChart.data.datasets[2].data = tempData;

      horizonChart.update("none");

    }

  }



  /* ==========================================================================

   *  ⚙️ ISO 10816 ASSET HEALTH ENGINE

   * ========================================================================== */

  function initVibrationChart() {

    var canvas = $("vibrationChart");

    if (!canvas || typeof Chart === "undefined") return;

    var ctx = canvas.getContext("2d");

    if (!ctx) return;



    var grad = ctx.createLinearGradient(0, 0, 0, 260);

    grad.addColorStop(0, "rgba(0, 229, 255, 0.35)");

    grad.addColorStop(1, "rgba(0, 229, 255, 0.02)");



    vibrationChart = new Chart(ctx, {

      type: "line",

      data: {

        labels: [],

        datasets: [

          { label: "Vibration RMS (mm/s)", data: [], borderColor: "#00E5FF", backgroundColor: grad, fill: true, tension: 0.35, borderWidth: 2.2, pointRadius: 0 },

          { label: "Zone B (1.8 mm/s)", data: [], borderColor: "#10B981", borderDash: [5, 5], borderWidth: 1.5, fill: false, pointRadius: 0 },

          { label: "Zone C (2.8 mm/s)", data: [], borderColor: "#F59E0B", borderDash: [5, 5], borderWidth: 1.5, fill: false, pointRadius: 0 },

          { label: "Zone D Critical (4.5 mm/s)", data: [], borderColor: "#EF4444", borderDash: [4, 4], borderWidth: 1.8, fill: false, pointRadius: 0 }

        ]

      },

      options: {

        responsive: true, maintainAspectRatio: false, animation: { duration: 0 },

        scales: {

          y: { min: 0, max: 6.0, ticks: { color: "rgba(232,238,247,.55)", font: { family: "JetBrains Mono", size: 10 } }, grid: { color: "rgba(255,255,255,.06)" } },

          x: { ticks: { color: "rgba(139,152,179,.8)", font: { family: "JetBrains Mono", size: 9 }, maxTicksLimit: 8 }, grid: { color: "rgba(255,255,255,.04)" } }

        },

        plugins: { legend: { labels: { color: "rgba(232,238,247,.7)", font: { size: 10 }, boxWidth: 14 } } }

      }

    });

  }



  function updateHealthUI(ah, motorTemp) {

    if (!ah) return;



    setText("healthIndexKpi", (ah.healthIndex || 98.4).toFixed(1) + "%");

    setHTML("vibRmsKpi", (ah.vibrationRms || 0.22).toFixed(2) + " <small>mm/s</small>");

    setText("cavitationKpi", (ah.cavitationIndex || 2.1).toFixed(1) + "%");

    setHTML("rulHoursKpi", Math.round(ah.rulHours || 6580).toLocaleString() + " <small>Hours</small>");



    setText("bearingWearVal", (ah.bearingWearPct || 4.8).toFixed(1) + "%");

    setText("operatingHoursVal", (ah.operatingHoursTotal || 1420.4).toFixed(1) + " Hours");

    setText("maintActionVal", ah.recommendedAction || "NOMINAL_OPERATION");

    setText("maintMotorTempVal", (motorTemp || 24.0).toFixed(1) + "°C");

    setText("maintRationaleText", ah.rationale || "Optimal baseline.");



    var zoneBadge = $("isoZoneBadge");

    if (zoneBadge) {

      zoneBadge.className = "live-pill";

      if (ah.vibrationIsoZone === 'ZONE_A') {

        zoneBadge.classList.add("zone-a");

        zoneBadge.innerHTML = "<span class='pulse-dot sm'></span> ISO ZONE A (OPTIMAL)";

      } else if (ah.vibrationIsoZone === 'ZONE_B') {

        zoneBadge.classList.add("zone-b");

        zoneBadge.innerHTML = "<span class='pulse-dot sm'></span> ISO ZONE B (ACCEPTABLE)";

      } else if (ah.vibrationIsoZone === 'ZONE_C') {

        zoneBadge.classList.add("zone-c");

        zoneBadge.innerHTML = "<span class='pulse-dot sm'></span> ISO ZONE C (DEGRADATION WARNING)";

      } else {

        zoneBadge.classList.add("zone-d");

        zoneBadge.innerHTML = "<span class='pulse-dot sm'></span> ISO ZONE D (CRITICAL TRIP RISK)";

      }

    }



    var now = new Date().toLocaleTimeString("en-GB", { hour12: false });

    vibLabels.push(now);

    vibSeries.push(ah.vibrationRms);

    while (vibLabels.length > FIFO_MAX) {

      vibLabels.shift();

      vibSeries.shift();

    }



    if (vibrationChart) {

      vibrationChart.data.labels = vibLabels;

      vibrationChart.data.datasets[0].data = vibSeries;

      vibrationChart.data.datasets[1].data = vibLabels.map(function () { return 1.8; });

      vibrationChart.data.datasets[2].data = vibLabels.map(function () { return 2.8; });

      vibrationChart.data.datasets[3].data = vibLabels.map(function () { return 4.5; });

      vibrationChart.update("none");

    }

  }



  /* ==========================================================================

   *  📊 AGRONOMIC ANALYTICS & ESG CHART ENGINE

   * ========================================================================== */

  function updateAnalyticsUI(esg, zones, litersSaved) {

    if (!esg) return;



    setText("esgEfficiencyKpi", (esg.efficiencyScorePct || 93.8).toFixed(1) + "%");

    setHTML("esgEnergyKpi", (esg.energySavedKwh || 64.1).toFixed(1) + " <small>kWh</small>");

    setHTML("esgCarbonKpi", (esg.co2OffsetKg || 33.3).toFixed(1) + " <small>kg CO₂</small>");

    setHTML("esgMoneyDzdKpi", Math.round(esg.totalSavedDzd || 19166).toLocaleString() + " <small>DZD</small>");



    setText("esgTotalSavedLiters", (litersSaved || 142.5).toFixed(1) + " Liters");

    setText("esgMoneyUsdVal", "$" + (esg.totalSavedUsd || 6.41).toFixed(2) + " USD");



    if (Array.isArray(zones) && zones.length) {

      renderZoneWaterChart(zones);

    }

  }



  function renderZoneWaterChart(zones) {

    var canvas = $("zoneWaterChart");

    if (!canvas || typeof Chart === "undefined") return;



    var labels = zones.map(function (z) { return z.id + " (" + z.crop + ")"; });

    var waterValues = zones.map(function (z) { return z.waterUsedL || 150; });



    if (!zoneWaterChart) {

      var ctx = canvas.getContext("2d");

      if (!ctx) return;

      zoneWaterChart = new Chart(ctx, {

        type: "bar",

        data: {

          labels: labels,

          datasets: [{

            label: "Cumulative Water Consumed (Liters)",

            data: waterValues,

            backgroundColor: [

              "rgba(0, 229, 255, 0.75)",

              "rgba(16, 185, 129, 0.75)",

              "rgba(245, 158, 11, 0.75)",

              "rgba(56, 189, 248, 0.75)",

              "rgba(139, 92, 246, 0.75)",

              "rgba(236, 72, 153, 0.75)"

            ],

            borderColor: "rgba(255, 255, 255, 0.2)",

            borderWidth: 1,

            borderRadius: 6

          }]

        },

        options: {

          responsive: true, maintainAspectRatio: false, animation: { duration: 0 },

          scales: {

            y: { beginAtZero: true, ticks: { color: "rgba(232,238,247,.55)", font: { family: "JetBrains Mono", size: 10 } }, grid: { color: "rgba(255,255,255,.06)" } },

            x: { ticks: { color: "rgba(139,152,179,.8)", font: { family: "JetBrains Mono", size: 10 } }, grid: { display: false } }

          },

          plugins: { legend: { display: false } }

        }

      });

    } else {

      zoneWaterChart.data.labels = labels;

      zoneWaterChart.data.datasets[0].data = waterValues;

      zoneWaterChart.update("none");

    }

  }



  /* ---------- Controls Binding ---------- */

  function bindControls() {

    function slider(id, fn) {

      var el = $(id); if (el) el.addEventListener("input", fn);

    }

    

    slider("KpSlider", function (e) {

      state.kp = parseFloat(e.target.value) || 0;

      setText("KpValue", state.kp.toFixed(2)); emitPid();

    });

    slider("KiSlider", function (e) {

      state.ki = parseFloat(e.target.value) || 0;

      setText("KiValue", state.ki.toFixed(4)); emitPid();

    });

    slider("KdSlider", function (e) {

      state.kd = parseFloat(e.target.value) || 0;

      setText("KdValue", state.kd.toFixed(2)); emitPid();

    });

    slider("setpointSlider", function (e) {

      state.setpoint = Math.max(0, Math.min(100, parseFloat(e.target.value) || 0));

      setText("setpointValue", state.setpoint.toFixed(1) + "%");

      if (socket && socket.connected) socket.emit("client:update_setpoint", state.setpoint);

    });

    slider("manualPwmSlider", function (e) {

      state.manualPwm = Math.max(0, Math.min(100, parseInt(e.target.value, 10) || 0));

      setText("manualPwmValue", state.manualPwm + "%");

      if (state.manual && socket && socket.connected) {

        socket.emit("client:manual_override", { enabled: true, manualPwm: state.manualPwm });

      }

      if (isHardwareMode) writeToUSB("PWM:" + state.manualPwm);

    });



    var toggle = $("manualToggle");

    if (toggle) toggle.addEventListener("change", function (e) {

      playClick();

      state.manual = !!e.target.checked;

      setManualUI(state.manual);

      if (socket && socket.connected) {

        socket.emit("client:manual_override", { enabled: state.manual, manualPwm: state.manualPwm });

      }

    });



    // 🗺️ Sidebar Multi-View Navigation Bindings

    var navDashboard = document.querySelector(".sidebar-nav [data-view='dashboard']");

    var navFleet = $("navFleet");

    var navPredictive = $("navPredictive");

    var navHealth = $("navHealth");

    var navPidView = $("navPidView");

    var navAnalytics = $("navAnalytics");



    if (navDashboard) navDashboard.addEventListener("click", function (e) { e.preventDefault(); playClick(); switchView("dashboard"); });

    if (navFleet) navFleet.addEventListener("click", function (e) { e.preventDefault(); playClick(); switchView("fleet"); });

    if (navPredictive) navPredictive.addEventListener("click", function (e) { e.preventDefault(); playClick(); switchView("predictive"); });

    if (navHealth) navHealth.addEventListener("click", function (e) { e.preventDefault(); playClick(); switchView("health"); });

    if (navPidView) navPidView.addEventListener("click", function (e) { e.preventDefault(); playClick(); switchView("pidView"); });

    if (navAnalytics) navAnalytics.addEventListener("click", function (e) { e.preventDefault(); playClick(); switchView("analytics"); });



    // Weather Simulation quick-scroll

    var weatherScrollBtn = document.querySelector(".sidebar-nav [data-scroll='disturbance']");

    if (weatherScrollBtn) {

      weatherScrollBtn.addEventListener("click", function (e) {

        e.preventDefault();

        playClick();

        switchView("dashboard");

        var distCard = $("disturbanceCard");

        if (distCard) distCard.scrollIntoView({ behavior: "smooth" });

      });

    }



    var jumpBtn = $("jumpToControlBtn");

    if (jumpBtn) {

      jumpBtn.addEventListener("click", function () {

        playClick(); switchView("dashboard");

      });

    }



    // ⚙️ Service Asset Button

    var serviceBtn = $("serviceAssetBtn");

    if (serviceBtn) {

      serviceBtn.addEventListener("click", function () {

        playClick();

        pressFlash(serviceBtn);

        if (!isOperatorAuthorized) {

          openModal("authModal");

          log("<strong style='color:var(--warn)'>[ACCESS DENIED]</strong> Operator authorization required to log preventive maintenance.");

          return;

        }

        if (socket && socket.connected) {

          socket.emit("client:service_asset");

        }

        log("<strong style='color:var(--ok)'><i class='fa-solid fa-wrench'></i> [MAINTENANCE LOGGED]</strong> Pump overhaul complete: Rotor bearings recalibrated and fatigue reset.");

      });

    }



    // 📊 Export CSV Button

    var exportBtn = $("exportCsvBtn");

    if (exportBtn) {

      exportBtn.addEventListener("click", function () {

        playClick();

        pressFlash(exportBtn);

        window.location.href = "/api/export-audit.csv";

        log("<strong style='color:var(--ok)'><i class='fa-solid fa-file-arrow-down'></i> [AUDIT EXPORT]</strong> Industrial CSV Telemetry log downloaded successfully.");

      });

    }



    // 🔌 Hardware Mode Dual-Toggle

    var simBtn = $("srcSimBtn");

    var usbBtn = $("srcUsbBtn");

    var connectBtn = $("usbConnectBtn");

    var statusChip = $("usbStatusChip");



    if (simBtn && usbBtn) {

      simBtn.addEventListener("click", function () {

        playClick();

        isHardwareMode = false;

        simBtn.classList.add("active");

        usbBtn.classList.remove("active");

        if (connectBtn) connectBtn.hidden = true;

        if (statusChip) statusChip.hidden = true;

        log("<strong style='color:var(--brand)'>[MODE]</strong> Switched to Digital Twin Virtual Simulator.");

      });



      usbBtn.addEventListener("click", function () {

        playClick();

        isHardwareMode = true;

        usbBtn.classList.add("active");

        simBtn.classList.remove("active");

        if (connectBtn && !usbPort) connectBtn.hidden = false;

        if (statusChip && usbPort) statusChip.hidden = false;

        log("<strong style='color:var(--ok)'><i class='fa-brands fa-usb'></i> [MODE]</strong> Physical Hardware Ingestion engaged. Ready for live sensors.");

      });

    }



    if (connectBtn) connectBtn.addEventListener("click", connectUSBHardware);



    // Geolocation Selector

    var locSelect = $("locationSelect");

    if (locSelect) {

      locSelect.addEventListener("change", function (e) {

        var key = e.target.value;

        playClick();

        if (socket && socket.connected) socket.emit("client:set_location", key);

        var locName = e.target.options[e.target.selectedIndex].text;

        log("<strong style='color:var(--brand)'><i class='fa-solid fa-satellite'></i> [SATELLITE]</strong> Pulling live weather for: <strong>" + escapeHTML(locName) + "</strong>");

      });

    }



    // Micro-Plots Crop Selection

    var zc = $("zonesContainer");

    if (zc) zc.addEventListener("click", function (e) {

      var t = e.target;

      var card = (t && t.closest) ? t.closest(".zone-card[data-zone]") : null;

      if (!card) return;

      var id = card.getAttribute("data-zone");

      if (!id) return;



      playClick();

      var cropTag = card.querySelector(".crop-tag");

      var cropName = cropTag ? cropTag.textContent.trim() : "Wheat";

      var profile = CROP_PROFILES[cropName] || CROP_PROFILES["Wheat"];



      state.activeZone = id;

      state.setpoint = profile.setpoint;

      state.kp = profile.kp;

      state.ki = profile.ki;

      state.kd = profile.kd;



      syncControls();

      setText("activeZoneBadge", "Active: Zone " + id + " (" + cropName + ")");

      var allCards = zc.querySelectorAll(".zone-card");

      Array.prototype.forEach.call(allCards, function (c) { c.classList.remove("active"); });

      card.classList.add("active");

      card.setAttribute("aria-pressed", "true");

      Array.prototype.forEach.call(allCards, function (c) {

        if (c !== card) c.setAttribute("aria-pressed", "false");

      });



      if (socket && socket.connected) {

        socket.emit("client:select_zone", id);

        socket.emit("client:update_setpoint", state.setpoint);

        emitPid();

      }

    });



    // Disturbance & Emergency

    function disturbance(type, label) {

      return function (e) {

        playClick();

        pressFlash(e && e.currentTarget);

        if (socket && socket.connected) socket.emit("client:disturbance", type);

        log("<strong>[WEATHER]</strong> " + label + " injected.");

      };

    }

    

    var dr = $("droughtBtn"), ra = $("rainBtn"), rs = $("resetBtn"), shutoff = $("shutoffBtn");

    if (dr) dr.addEventListener("click", disturbance("drought", "<span style='color:var(--warn)'>Severe Drought</span>"));

    if (ra) ra.addEventListener("click", disturbance("rain", "<span style='color:var(--brand)'>Heavy Rain</span>"));

    

    if (shutoff) shutoff.addEventListener("click", function (e) {

      playEmergencySiren();

      pressFlash(e.currentTarget);

      shutoff.classList.add("armed");

      state.manual = true; state.manualPwm = 0;

      var t = $("manualToggle"); if (t) t.checked = true;

      setManualUI(true);

      var pwm = $("manualPwmSlider"); if (pwm) pwm.value = 0;

      setText("manualPwmValue", "0%");

      if (socket && socket.connected) socket.emit("client:manual_override", { enabled: true, manualPwm: 0 });

      if (isHardwareMode) writeToUSB("EMERGENCY:1");

      log("<strong style='color:var(--crit)'><i class='fa-solid fa-octagon-xmark'></i> [EMERGENCY]</strong> Manual shutoff engaged!");

    });

    

    if (rs) rs.addEventListener("click", function (e) {

      playClick();

      pressFlash(e.currentTarget);

      if (socket && socket.connected) {

        // فك أي قفل أمان طارئ وإعادة النظام للوضع الطبيعي التلقائي

        socket.emit("client:operator_reset", { pin: "8492" });

        socket.emit("client:manual_override", { enabled: false, manualPwm: 0 });

        socket.emit("client:update_setpoint", 55);

        socket.emit("client:update_pid", { kp: 2.0, ki: 0.1, kd: 0.5 });

      }

      state.manual = false; state.kp = 2.0; state.ki = 0.1; state.kd = 0.5; state.setpoint = 55;

      syncControls();

      var t = $("manualToggle"); if (t) t.checked = false;

      setManualUI(false);

      var shut = $("shutoffBtn"); if (shut) shut.classList.remove("armed");

      log("<strong style='color:var(--ok)'><i class='fa-solid fa-rotate-left'></i> [RESET]</strong> Industrial safety trip reset & PID parameters restored.");

    });



    // Audio Mute/Unmute

    var audioBtn = $("audioToggleBtn");

    if (audioBtn) {

      audioBtn.addEventListener("click", function () {

        initAudio();

        audioMuted = !audioMuted;

        audioBtn.classList.toggle("muted", audioMuted);

        var icon = $("audioIcon");

        if (icon) icon.className = audioMuted ? "fa-solid fa-volume-xmark" : "fa-solid fa-volume-high";

      });

    }



    // Security Authorization Binds

    var authBtn = $("authBtn");

    if (authBtn) {

      authBtn.addEventListener("click", function () {

        if (!isOperatorAuthorized) openModal("authModal");

      });

    }



    var submitAuthBtn = $("submitAuthBtn");

    if (submitAuthBtn) {

      submitAuthBtn.addEventListener("click", function () {

        var pinInput = $("operatorPinInput");

        var pin = pinInput ? pinInput.value : "";

        if (socket && socket.connected) socket.emit("client:auth", pin);

      });

    }



    bindModals();

  }



  function openModal(id, trigger) {

    var m = $(id); if (!m) return;

    lastModalTrigger = trigger || document.activeElement;

    m.classList.add("open");

    m.setAttribute("aria-hidden", "false");

    var authError = $("authErrorMsg");

    if (id === "authModal" && authError) {

      authError.hidden = true;

      authError.style.display = "none";

    }

    var focusTarget = m.querySelector("input, select, button:not([data-close])");

    if (focusTarget) setTimeout(function () { focusTarget.focus(); }, 0);

  }

  function closeModal(m) {

    if (typeof m === "string") m = $(m); if (!m) return;

    m.classList.remove("open");

    m.setAttribute("aria-hidden", "true");

    if (lastModalTrigger && typeof lastModalTrigger.focus === "function") {

      lastModalTrigger.focus();

    }

    lastModalTrigger = null;

  }

  function syncSettingsForm() {

    var s = $("settingsSetpoint"), c = $("settingsTankCap"), soil = $("soilType");

    if (s) s.value = state.setpoint; if (c) c.value = state.tankCapacity;

    if (soil) soil.value = state.soilType;

  }

  

  /* ---------- 🛠️ Modal Activation & Trigger Binder ---------- */

  function bindModals() {

    var modalTriggers = document.querySelectorAll("[data-modal]");

    Array.prototype.forEach.call(modalTriggers, function (trigger) {

      trigger.addEventListener("click", function (e) {

        e.preventDefault();

        playClick();

        var targetId = trigger.getAttribute("data-modal");

        if (targetId) openModal(targetId, trigger);

      });

    });



    var overlays = document.querySelectorAll(".modal-overlay");

    Array.prototype.forEach.call(overlays, function (o) {

      o.addEventListener("click", function (e) { if (e.target === o) closeModal(o); });

      var closers = o.querySelectorAll("[data-close]");

      Array.prototype.forEach.call(closers, function (b) {

        b.addEventListener("click", function () { closeModal(o); });

      });

    });

    document.addEventListener("keydown", function (e) {

      if (e.key !== "Escape") return;

      var open = document.querySelector(".modal-overlay.open");

      if (open) closeModal(open);

    });

    

    var save = $("settingsSave");

    if (save) save.addEventListener("click", function () {

      pressFlash(save);

      var s = $("settingsSetpoint"), c = $("settingsTankCap"), soil = $("soilType");

      var sp = s ? Math.max(0, Math.min(100, parseFloat(s.value) || state.setpoint)) : state.setpoint;

      var cap = c ? Math.max(20, Math.min(2000, parseFloat(c.value) || state.tankCapacity)) : state.tankCapacity;

      var st = soil && soil.value ? soil.value : state.soilType;

      state.setpoint = sp; state.tankCapacity = cap; state.soilType = st;

      setText("setpointValue", sp.toFixed(1) + "%");

      var spSlider = $("setpointSlider"); if (spSlider) spSlider.value = sp;

      if (socket && socket.connected) {

        socket.emit("client:update_settings", { setpoint: sp, tankCapacity: cap, soilType: st });

        socket.emit("client:update_setpoint", sp);

      }

      closeModal("settingsModal");

    });

    

    var accept = $("consentAccept");

    if (accept) accept.addEventListener("click", function () {

      closeModal("termsModal");

    });

  }



  function boot() {

    initChart(); 

    bindControls();

    setStatus(false);

    try {

      socket = io({ transports: ["websocket", "polling"], reconnectionAttempts: 10 });

    } catch (e) { return; }

    

    socket.on("connect", function () { setStatus(true); });

    socket.on("disconnect", function () { setStatus(false); });

    socket.on("connect_error", function () { setStatus(false); });

    socket.on("telemetry", onTelemetry);

    

    socket.on("auth:success", function () {

      isOperatorAuthorized = true;

      closeModal("authModal");

      playTone(900, 'sine', 0.2, 0.15);

      var authIcon = $("authIcon"); if (authIcon) authIcon.className = "fa-solid fa-unlock";

      var authLabel = $("authLabel"); if (authLabel) authLabel.textContent = "OPERATOR";

      var authBtn = $("authBtn");

      if (authBtn) {

        authBtn.classList.remove("lock");

        authBtn.classList.add("unlocked");

      }

      log("<strong style='color:var(--ok)'>[SECURITY]</strong> SCADA Console unlocked: Full Operator Access.");

    });



    socket.on("auth:failed", function (data) {

      playEmergencySiren();

      var err = $("authErrorMsg");

      if (err) { err.hidden = false; err.style.display = "block"; }

      log("<strong style='color:var(--crit)'>[SECURITY]</strong> " + escapeHTML(data && data.msg ? data.msg : "Invalid Passcode"));

    });



    socket.on("firewall:alert", function (data) {

      playCautionBeep();

      log("<strong style='color:var(--crit)'>[FIREWALL]</strong> " + escapeHTML(data && data.msg ? data.msg : "Firewall alert"));

    });



    window.addEventListener("resize", function () { 

      if (chart) chart.resize(); 

      if (mapInstance) mapInstance.invalidateSize();

      if (horizonChart) horizonChart.resize();

      if (vibrationChart) vibrationChart.resize();

      if (zoneWaterChart) zoneWaterChart.resize();

    });

    document.addEventListener("click", function () { initAudio(); }, { once: true });

  }



  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);

  else boot();

})(); 

قمت بفحص كود public/app.js سطرًا بسطر. الكود مبني بأسلوب وتوزيع ممتازين (Modular SCADA Architecture)، ويحتوي على مزايا متقدمة مثل دعم الـ Web Serial للعتاد الحقيقي، خرائط GIS، أصوات Web Audio API التفاعلية، ومحاكاة سجلات Modbus TCP.

ومع ذلك، كشف التدقيق عن 3 نقاط تكامل حرجة (Integration Mismatches) بين app.js وما قمنا بدمجه مؤخراً في server.js:

1. تجاهل طيف بايثون (The Python FFT Bypass)
المشكلة: في دالة onTelemetry، يقوم الكود دائماً بحساب الـ FFT محلياً في المتصفح عبر JavaScript:

JavaScript
var fftMagnitudes = HydroSyncCharts.computeFFT(waveformSource);
HydroSyncCharts.updateFFTChart(fftMagnitudes);
هذا يعني أنه حتى عندما يكون محرك عبد الحق (Python FastAPI) يعمل أونلاين ويرسل طيف الترددات الحقيقي عالي الدقة في حزمة التليمتري (d.fft)، فإن الواجهة تتجاهله وتستمر في رسم الحساب التقريبي للمتصفح!

الحل الهندسي: يجب فحص حزمة التليمتري؛ إذا كان d.fft متوفراً وصالحاً نستخدمه مباشرة، وإذا لم يتوفر نلجأ إلى الحساب المحلي كبديل (Fallback):

JavaScript
if (d.fft && Array.isArray(d.fft.magnitudes) && d.fft.magnitudes.length > 0) {
  HydroSyncCharts.updateFFTChart(d.fft.magnitudes, d.fft.frequencies_hz);
} else {
  var fftMagnitudes = HydroSyncCharts.computeFFT(waveformSource);
  HydroSyncCharts.updateFFTChart(fftMagnitudes);
}
2. زر الطوارئ الكبير (Emergency Stop Misrouting)
المشكلة: عند الضغط على زر الإيقاف الطارئ shutoffBtn، يرسل الكود:

JavaScript
socket.emit("client:manual_override", { enabled: true, manualPwm: 0 });
في server.js، حدث client:manual_override محمي بجدار أمان ولا يعمل إلا إذا كان المستخدم مسجلاً كـ OPERATOR. إذا ضغط أي زائر أو مشغل غير مسجل على زر الطوارئ، سيرفض السيرفر الأمر فوراً!

الحل الهندسي: جهزنا في server.js مساراً مخصصاً للطوارئ العامة لا يتطلب PIN (client:emergency_stop). يجب ربط الزر به مباشرة:

JavaScript
if (socket && socket.connected) {
  socket.emit("client:emergency_stop");
}
3. زر إعادة الضبط (Reset Interlock Trip)
المشكلة: عند الضغط على زر resetBtn، يرسل الكود أمر فك القفل دون التحقق مما إذا كان المشغل قد قام بتسجيل الدخول أم لا:

JavaScript
socket.emit("client:operator_reset", { pin: "8492" });
في السيرفر، هذا الأمر يتطلب أن تكون الجلسة موثقة (verifyOperatorAuth). إذا لم يكن المشغل موثقاً، يُرفض الأمر بصمت وتظهر في السجلات رسالة Blocked.

الحل الهندسي: مثلما فعلت في زر الصيانة serviceBtn، يجب فتح نافذة إدخال الرمز السري إذا لم يكن المستخدم موثقاً:

JavaScript
if (!isOperatorAuthorized) {
  openModal("authModal");
  log("<strong style='color:var(--warn)'>[ACCESS DENIED]</strong> Operator PIN required to reset safety trip.");
  return;
}
نقاط التوافق الممتازة المكتشفة في الملف:
تسمية المناطق: الكود يستقبل d.activeZoneId بشكل صحيح تماماً في دالة renderZones(d.zones, d.activeZoneId)، وهو ما يتطابق مع التعديل الذي أصلحناه في قاعدة البيانات.

محاكاة P&ID و Modbus: التحديث اللحظي لجدول Modbus Coils & Holding Registers دقيق جداً ويعكس القيم الحقيقية للمضخة والحساسات.

التكامل مع الرسوم البيانية: الكود يراعي أداء المتصفح ولا يحدّث مخططات الاهتزاز إلا إذا كانت الشاشة النشطة هي viewHealth، مما يوفر استهلاك المعالج والذاكرة.

هل ترغب في تطبيق هذه التحسينات الثلاثة في public/app.js لربط السيرفر والواجهة بسلاسة تامة، أم ننتظر فحص ملفات الـ PR الخاص بسامي أولاً؟

هل تريدني أن أرسل لك ملف style.css الذي قام بتعديله؟

نعم، أرسله فوراً!

سأقوم بفحصه بدقة للتركيز على:

سلامة الهيكل والعناصر التفاعلية: التأكد من أن تعديلاته لم تكسر تخطيط الـ Grid أو Flexbox الخاص بالخرائط، ومحاكاة الـ P&ID، ورسوم الـ Canvas البيانية.

فئات الأمان والإنذار: التأكد من أنه لم يعبث بالفئات المخصصة لحالات الطوارئ والأقفال الصناعية (مثل .emergency، .degraded، .nominal، أو مؤشرات الـ Interlock).

التوازن اللوني والتباين البصري: مراجعة الألوان ومقارنتها بنموذج التموجات (Cyan & Emerald) الذي ناقشناه لضمان تحقيق الهوية البصرية الجذابة دون إجهاد العين.

الصق محتوى style.css لنبدأ المعاينة مباشرة!

public/style.css : /* ==========================================================================

HydroSync — Irrigation Control Console

Single consolidated stylesheet.



Design rules enforced here:

1. Colour carries STATE, not decoration. Neutral surfaces by default;

amber = warning, red = critical, emerald = confirmed-good only where

the operator must confirm a good state. Cyan is brand + active nav.

2. Motion means "pay attention". Only three animations remain:

critical alarm, live pipe flow, P&ID flow. Nothing idle pulses.

3. One type scale. Minimum readable size is 11px.

4. Three visual tiers: primary (safety), secondary (analysis),

tertiary (reference). They must not all look the same.

========================================================================== */



/* --------------------------------------------------------------------------

1. TOKENS

-------------------------------------------------------------------------- */

:root {

/* Surfaces — neutral, low contrast, calm */

--canvas: #060913;

--surface-1: #0b1220; /* cards */

--surface-2: #0f1728; /* raised panels, table head */

--surface-3: #131d31; /* inset wells */

--surface-sunk: rgba(0, 0, 0, 0.34);



/* Lines */

--line: rgba(148, 163, 184, 0.14);

--line-strong: rgba(148, 163, 184, 0.26);

--line-accent: rgba(0, 229, 255, 0.3);



/* Text */

--text: #e6ecf5;

--text-dim: #9aa8c0;

--text-faint: #6f7d96;



/* State — reserved, never decorative */

--ok: #10b981;

--warn: #f59e0b;

--crit: #ef4444;

--info: #38bdf8;

--brand: #00e5ff;



/* Typography */

--mono: "JetBrains Mono", ui-monospace, "SF Mono", monospace;

--sans: "Space Grotesk", system-ui, -apple-system, sans-serif;



--fs-xs: 11px; /* labels, chips — hard floor */

--fs-sm: 12px;

--fs-md: 13px; /* body */

--fs-lg: 15px; /* card titles, emphasised values */

--fs-xl: 20px;

--fs-2xl: 26px; /* KPI figures */

--fs-3xl: 32px; /* gauge centre */



--lh-tight: 1.25;

--lh-body: 1.55;



/* Space — 4px base */

--s-1: 4px;

--s-2: 8px;

--s-3: 12px;

--s-4: 16px;

--s-5: 20px;

--s-6: 28px;



/* Radii */

--r-sm: 8px;

--r-md: 12px;

--r-lg: 16px;



/* Elevation */

--shadow: 0 10px 28px rgba(0, 0, 0, 0.3);

--shadow-mod: 0 30px 80px rgba(0, 0, 0, 0.6);



--sidebar-w: 260px;



/* Professional extension tokens */

--surface-0: #050914;

--glow-cyan: 0 0 28px rgba(0, 229, 255, 0.1);

--shadow-card: 0 12px 32px rgba(0, 0, 0, 0.28);

--shadow-modal: 0 30px 80px rgba(0, 0, 0, 0.6);

--r-xl: 20px;

--z-sidebar: 50;

--z-header: 40;

--z-modal: 100;

--flow-speed: 1.4s;

}



/* --------------------------------------------------------------------------

2. RESET & BASE

-------------------------------------------------------------------------- */

*,

*::before,

*::after {

box-sizing: border-box;

margin: 0;

padding: 0;

}



html {

scroll-behavior: smooth;

}



body {

font-family: var(--sans);

font-size: var(--fs-md);

line-height: var(--lh-body);

color: var(--text);

background: var(--canvas);

min-height: 100vh;

-webkit-font-smoothing: antialiased;

}



h1,

h2,

h3 {

line-height: var(--lh-tight);

font-weight: 600;

}



/* Keyboard focus — one consistent ring everywhere */

:where(a, button, select, input, [tabindex]):focus-visible {

outline: 2px solid var(--brand);

outline-offset: 2px;

border-radius: var(--r-sm);

}



.visually-hidden {

position: absolute;

width: 1px;

height: 1px;

overflow: hidden;

clip: rect(0 0 0 0);

white-space: nowrap;

}



/* --------------------------------------------------------------------------

3. SIDEBAR

-------------------------------------------------------------------------- */

.sidebar {

position: fixed;

inset: 0 auto 0 0;

width: var(--sidebar-w);

background: var(--surface-1);

border-right: 1px solid var(--line);

display: flex;

flex-direction: column;

gap: var(--s-5);

padding: var(--s-5) var(--s-3);

z-index: 50;

overflow-y: auto;

}



.sidebar-brand {

display: flex;

gap: var(--s-3);

align-items: center;

padding: 0 var(--s-2);

}



.brand-icon {

width: 38px;

height: 38px;

border-radius: var(--r-md);

display: grid;

place-items: center;

background: var(--surface-3);

border: 1px solid var(--line-accent);

color: var(--brand);

font-size: var(--fs-xl);

flex: none;

}



.brand-text h2 {

font-size: var(--fs-lg);

letter-spacing: 0.2px;

}

.brand-text p {

color: var(--text-faint);

font-size: var(--fs-xs);

}



.sidebar-label {

font-size: var(--fs-xs);

letter-spacing: 0.08em;

color: var(--text-faint);

font-weight: 500;

}



.sidebar-section {

display: grid;

gap: var(--s-2);

}



/* Connection state — this IS state, so it may carry colour */

.connection-badge {

display: flex;

align-items: center;

gap: var(--s-2);

background: var(--surface-sunk);

border: 1px solid var(--line);

border-radius: var(--r-md);

padding: var(--s-2) var(--s-3);

font-family: var(--mono);

font-size: var(--fs-sm);

color: var(--text-dim);

}

.connection-badge.online {

border-color: rgba(16, 185, 129, 0.4);

color: var(--ok);

}

.connection-badge.offline {

border-color: rgba(239, 68, 68, 0.45);

color: var(--crit);

}



.status-dot {

width: 8px;

height: 8px;

border-radius: 50%;

background: var(--text-faint);

flex: none;

}

.connection-badge.online .status-dot {

background: var(--ok);

}

.connection-badge.offline .status-dot {

background: var(--crit);

}

.status-dot.sm {

width: 6px;

height: 6px;

}



/* Telemetry heartbeat: flashes only when a packet actually lands */

.heartbeat-row {

display: flex;

align-items: center;

gap: var(--s-2);

color: var(--text-faint);

font-size: var(--fs-xs);

}

.heartbeat {

width: 6px;

height: 6px;

border-radius: 50%;

background: var(--text-faint);

transition: background 0.12s ease;

}

.heartbeat.beat {

background: var(--brand);

}



.sidebar-nav {

display: grid;

gap: 2px;

}



.nav-item {

display: flex;

align-items: center;

gap: var(--s-3);

min-height: 42px;

padding: 0 var(--s-3);

text-decoration: none;

color: var(--text-dim);

border-radius: var(--r-sm);

border-left: 2px solid transparent;

font-size: var(--fs-md);

transition:

background 0.15s ease,

color 0.15s ease;

cursor: pointer;

}

.nav-item i {

width: 18px;

text-align: center;

font-size: var(--fs-md);

}

.nav-item:hover {

background: rgba(255, 255, 255, 0.04);

color: var(--text);

}

.nav-item.active {

background: rgba(0, 229, 255, 0.08);

border-left-color: var(--brand);

color: var(--text);

}

.nav-item.active i {

color: var(--brand);

}



.sidebar-footer {

margin-top: auto;

display: grid;

gap: var(--s-2);

padding-top: var(--s-3);

}



.system-status-line {

display: inline-flex;

align-items: center;

gap: var(--s-2);

font-family: var(--mono);

font-size: var(--fs-xs);

color: var(--text-dim);

border: 1px solid var(--line);

padding: var(--s-2) var(--s-3);

border-radius: var(--r-sm);

}

.system-status-line.is-ok {

color: var(--ok);

}

.system-status-line.is-warn {

color: var(--warn);

border-color: rgba(245, 158, 11, 0.4);

}

.system-status-line.is-crit {

color: var(--crit);

border-color: rgba(239, 68, 68, 0.5);

}



.sidebar-version {

color: var(--text-faint);

font-size: var(--fs-xs);

}



/* --------------------------------------------------------------------------

4. HEADER

-------------------------------------------------------------------------- */

.layout-main {

margin-left: var(--sidebar-w);

min-height: 100vh;

min-width: 0;

display: flex;

flex-direction: column;

}



.top-header {

position: sticky;

top: 0;

z-index: 40;

display: flex;

align-items: center;

gap: var(--s-4);

min-height: 64px;

padding: var(--s-3) var(--s-6);

background: rgba(6, 9, 19, 0.92);

backdrop-filter: blur(12px);

border-bottom: 1px solid var(--line);

}



.header-title h1 {

font-size: var(--fs-lg);

}

.header-title p {

color: var(--text-faint);

font-size: var(--fs-sm);

}



.header-meta {

margin-left: auto;

display: flex;

align-items: center;

gap: var(--s-2);

}



/* Status cluster (read-only) vs action cluster (clickable) */

.header-status {

display: flex;

align-items: center;

gap: var(--s-2);

padding-right: var(--s-3);

border-right: 1px solid var(--line);

}

.header-actions {

display: flex;

align-items: center;

gap: var(--s-2);

}



.icon-btn {

background: transparent;

border: 1px solid var(--line);

color: var(--text-dim);

width: 36px;

height: 36px;

border-radius: var(--r-sm);

cursor: pointer;

display: none;

align-items: center;

justify-content: center;

transition:

border-color 0.15s ease,

color 0.15s ease;

}

.icon-btn:hover {

border-color: var(--line-strong);

color: var(--text);

}



/* Shared pill shape for every header chip */

.chip {

font-family: var(--mono);

font-size: var(--fs-xs);

border: 1px solid var(--line);

background: transparent;

color: var(--text-dim);

padding: 6px 10px;

border-radius: 999px;

display: inline-flex;

align-items: center;

gap: 6px;

white-space: nowrap;

}



.telemetry-source-group {

display: inline-flex;

border: 1px solid var(--line);

border-radius: 999px;

padding: 2px;

gap: 2px;

}

.source-toggle {

background: transparent;

border: none;

color: var(--text-faint);

font-family: var(--mono);

font-size: var(--fs-xs);

font-weight: 500;

padding: 5px 11px;

border-radius: 999px;

cursor: pointer;

display: inline-flex;

align-items: center;

gap: 6px;

transition:

color 0.15s ease,

background 0.15s ease;

}

.source-toggle:hover {

color: var(--text);

}

.source-toggle.active {

background: rgba(0, 229, 255, 0.12);

color: var(--brand);

}



.btn-usb-link {

font-family: var(--mono);

font-size: var(--fs-xs);

font-weight: 500;

background: transparent;

color: var(--brand);

border: 1px solid var(--line-accent);

padding: 6px 12px;

border-radius: 999px;

cursor: pointer;

display: inline-flex;

align-items: center;

gap: 6px;

}

.btn-usb-link:hover {

background: rgba(0, 229, 255, 0.08);

}



.usb-status-chip {

color: var(--ok);

border-color: rgba(16, 185, 129, 0.4);

}



.auth-btn {

font-family: var(--mono);

font-size: var(--fs-xs);

font-weight: 600;

border-radius: 999px;

padding: 6px 12px;

cursor: pointer;

display: inline-flex;

align-items: center;

gap: 6px;

background: transparent;

transition: background 0.15s ease;

}

.auth-btn.lock {

border: 1px solid rgba(245, 158, 11, 0.4);

color: var(--warn);

}

.auth-btn.lock:hover {

background: rgba(245, 158, 11, 0.1);

}

.auth-btn.unlocked {

border: 1px solid rgba(16, 185, 129, 0.45);

color: var(--ok);

}



.audio-btn {

background: transparent;

border: 1px solid var(--line);

color: var(--text-dim);

width: 32px;

height: 32px;

border-radius: 999px;

cursor: pointer;

display: inline-flex;

align-items: center;

justify-content: center;

transition:

border-color 0.15s ease,

color 0.15s ease;

}

.audio-btn:hover {

border-color: var(--line-strong);

color: var(--text);

}

.audio-btn.muted {

color: var(--text-faint);

}



/* --------------------------------------------------------------------------

5. STALE-DATA STATE

When the socket drops, every reading on screen becomes untrustworthy.

Say so loudly and dim the numbers, rather than showing a dead value

as if it were live.

-------------------------------------------------------------------------- */

.stale-bar {

display: none;

align-items: center;

gap: var(--s-2);

padding: var(--s-2) var(--s-4);

background: rgba(245, 158, 11, 0.12);

border-bottom: 1px solid rgba(245, 158, 11, 0.4);

color: var(--warn);

font-family: var(--mono);

font-size: var(--fs-xs);

}

body.is-stale .stale-bar {

display: flex;

}



body.is-stale .dashboard .gauge-card,

body.is-stale .dashboard .compact-kpi-card,

body.is-stale .dashboard .chart-card,

body.is-stale .dashboard .twin-card,

body.is-stale .dashboard .fleet-kpi-bar,

body.is-stale .dashboard .climate-banner {

opacity: 0.45;

filter: saturate(0.4);

transition: opacity 0.3s ease;

}

body.is-stale .live-pill {

opacity: 0.4;

}



/* --------------------------------------------------------------------------

6. DASHBOARD SHELL

-------------------------------------------------------------------------- */

.dashboard {

padding: var(--s-5) var(--s-6) 48px;

display: grid;

gap: var(--s-4);

max-width: 1680px;

width: 100%;

margin: 0 auto;

}



.view-screen {

display: flex;

flex-direction: column;

gap: var(--s-4);

width: 100%;

}

.view-screen[hidden] {

display: none !important;

}



#viewDashboard.active {

display: grid;

grid-template-columns: minmax(0, 1fr) 320px;

grid-template-areas:

"kpis kpis"

"twin safety"

"twin alarms"

"moisture weather"

"pumpflow ai"

"zones zones"

"controls controls"

"logs logs";

align-items: stretch;

gap: var(--s-3);

}

#viewDashboard > * {

min-width: 0;

}

#viewDashboard > .card-grid {

grid-area: kpis;

}

#viewDashboard > #twin {

grid-area: twin;

}

#viewDashboard > #safetyBanner {

grid-area: safety;

}

#viewDashboard > #alarmPanel {

grid-area: alarms;

}

#viewDashboard > #climateBanner {

grid-area: weather;

}

#viewDashboard > #aiSummaryPanel {

grid-area: ai;

}

#viewDashboard > #telemetry {

grid-area: moisture;

}

#viewDashboard > #pumpFlowTelemetry {

grid-area: pumpflow;

}

#viewDashboard > #fieldSection {

grid-area: zones;

}

#viewDashboard > .two-col {

grid-area: controls;

}

#viewDashboard > #logs {

grid-area: logs;

}



/* --------------------------------------------------------------------------

7. CARD TIERS

Not every panel deserves the same weight. Three levels:

.tier-primary safety-critical — strongest border, most padding

.tier-secondary analysis — plain card

.tier-tertiary reference — flat, recedes into the page

-------------------------------------------------------------------------- */

.glass-card,

.card {

background: var(--surface-1);

border: 1px solid var(--line);

border-radius: var(--r-md);

padding: var(--s-4);

position: relative;

}



.tier-primary {

background: var(--surface-2);

border-color: var(--line-strong);

padding: var(--s-4);

box-shadow: var(--shadow);

}

.tier-secondary {

background: var(--surface-1);

}

.tier-tertiary {

background: transparent;

border-color: var(--line);

padding: var(--s-3);

}



.card-top {

display: flex;

align-items: center;

justify-content: space-between;

gap: var(--s-3);

margin-bottom: var(--s-3);

}

.card-title {

font-size: var(--fs-md);

font-weight: 600;

display: inline-flex;

gap: var(--s-2);

align-items: center;

}

.card-title i {

color: var(--text-faint);

font-size: var(--fs-md);

}

.tier-primary .card-title i {

color: var(--brand);

}



.card-sub,

.card-unit {

font-family: var(--mono);

font-size: var(--fs-xs);

font-weight: 400;

color: var(--text-faint);

border: 1px solid var(--line);

padding: 3px 8px;

border-radius: 999px;

}



.card-head {

display: flex;

align-items: center;

justify-content: space-between;

gap: var(--s-3);

margin-bottom: var(--s-3);

}

.card-head h3 {

font-size: var(--fs-md);

font-weight: 600;

display: inline-flex;

gap: var(--s-2);

align-items: center;

}

.card-head h3 i {

color: var(--text-faint);

}



.badge {

font-family: var(--mono);

font-size: var(--fs-xs);

color: var(--text-dim);

border: 1px solid var(--line);

padding: 5px 10px;

border-radius: 999px;

white-space: nowrap;

}

.badge-subtle {

color: var(--text-faint);

}



/* "Live" pill — no pulse. The heartbeat in the sidebar is the liveness cue. */

.live-pill {

display: inline-flex;

align-items: center;

gap: 6px;

font-family: var(--mono);

font-size: var(--fs-xs);

color: var(--text-dim);

border: 1px solid var(--line);

padding: 5px 10px;

border-radius: 999px;

}

.live-pill .status-dot {

background: var(--ok);

}



.section-note {

text-align: center;

}



/* --------------------------------------------------------------------------

8. SAFETY BANNER (primary tier — the one thing that may shout)

-------------------------------------------------------------------------- */

.safety-banner {

display: block;

}

.safety-status {

display: flex;

align-items: flex-start;

gap: var(--s-3);

}

.safety-status i {

font-size: var(--fs-xl);

margin-top: 2px;

}

.safety-status strong {

font-family: var(--mono);

font-size: var(--fs-sm);

letter-spacing: 0.04em;

display: block;

}

.safety-status p {

font-size: var(--fs-xs);

color: var(--text-dim);

margin-top: 3px;

}



.safety-metrics {

display: grid;

grid-template-columns: 1fr 1fr;

gap: var(--s-2);

margin-top: var(--s-3);

}

.safety-chip {

font-family: var(--mono);

font-size: var(--fs-xs);

border: 1px solid var(--line);

padding: 5px 8px;

border-radius: var(--r-sm);

color: var(--text-dim);

display: inline-flex;

align-items: center;

gap: 5px;

}



.safety-banner.nominal .safety-status i,

.safety-banner.nominal .safety-status strong {

color: var(--ok);

}



.safety-banner.degraded {

border-color: rgba(245, 158, 11, 0.5);

background: rgba(245, 158, 11, 0.07);

}

.safety-banner.degraded .safety-status i,

.safety-banner.degraded .safety-status strong {

color: var(--warn);

}



.safety-banner.emergency {

border-color: var(--crit);

background: rgba(239, 68, 68, 0.1);

animation: criticalPulse 1.4s ease-in-out infinite;

}

.safety-banner.emergency .safety-status i,

.safety-banner.emergency .safety-status strong {

color: var(--crit);

}



/* The ONLY idle animation left in the system. */

@keyframes criticalPulse {

0%,

100% {

box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.35);

}

50% {

box-shadow: 0 0 0 5px rgba(239, 68, 68, 0);

}

}



/* --------------------------------------------------------------------------

9. ALARMS

-------------------------------------------------------------------------- */

.alarm-count {

min-width: 24px;

height: 22px;

padding: 0 7px;

display: inline-grid;

place-items: center;

border-radius: 999px;

background: var(--surface-3);

border: 1px solid var(--line);

color: var(--text-dim);

font-family: var(--mono);

font-size: var(--fs-xs);

}

.alarm-panel.has-warning .alarm-count {

color: var(--warn);

border-color: rgba(245, 158, 11, 0.5);

}

.alarm-panel.has-critical .alarm-count {

color: var(--crit);

border-color: rgba(239, 68, 68, 0.55);

}

.alarm-panel.has-critical {

border-color: rgba(239, 68, 68, 0.4);

}



.alarm-list {

display: grid;

gap: var(--s-1);

}

.alarm-row {

display: grid;

grid-template-columns: 16px minmax(0, 1fr) auto;

gap: var(--s-2);

align-items: center;

padding: var(--s-2);

border-radius: var(--r-sm);

background: var(--surface-sunk);

border: 1px solid var(--line);

font-size: var(--fs-xs);

}

.alarm-row span {

overflow: hidden;

text-overflow: ellipsis;

white-space: nowrap;

}

.alarm-row time {

font-family: var(--mono);

color: var(--text-faint);

font-size: var(--fs-xs);

}

.alarm-row.critical {

border-color: rgba(239, 68, 68, 0.4);

color: #fecaca;

}

.alarm-row.critical i {

color: var(--crit);

}

.alarm-row.warning {

border-color: rgba(245, 158, 11, 0.35);

color: #fde68a;

}

.alarm-row.warning i {

color: var(--warn);

}



.alarm-empty {

display: flex;

align-items: center;

gap: var(--s-2);

color: var(--text-faint);

font-family: var(--mono);

font-size: var(--fs-xs);

padding: var(--s-3) var(--s-1);

}



/* --------------------------------------------------------------------------

10. AI SUMMARY PANEL

-------------------------------------------------------------------------- */

.ai-engine-line {

display: flex;

align-items: center;

gap: var(--s-2);

font-family: var(--mono);

color: var(--text-dim);

font-size: var(--fs-xs);

}

.ai-summary-panel > p {

color: var(--text-faint);

font-size: var(--fs-xs);

line-height: var(--lh-body);

margin: var(--s-2) 0 var(--s-3);

}

.ai-status-badge {

padding: 4px 8px;

border-radius: 999px;

font-family: var(--mono);

font-size: var(--fs-xs);

font-weight: 600;

border: 1px solid var(--line);

color: var(--text-faint);

}

.ai-status-badge.online {

color: var(--ok);

border-color: rgba(16, 185, 129, 0.4);

}

.ai-status-badge.fallback {

color: var(--warn);

border-color: rgba(245, 158, 11, 0.4);

}



.ai-summary-grid {

display: grid;

grid-template-columns: 1fr 1fr;

gap: var(--s-2);

}

.ai-summary-grid div {

padding: var(--s-2);

border: 1px solid var(--line);

border-radius: var(--r-sm);

background: var(--surface-sunk);

}

.ai-summary-grid span {

display: block;

color: var(--text-faint);

font-family: var(--mono);

font-size: var(--fs-xs);

margin-bottom: 3px;

}

.ai-summary-grid strong {

font-family: var(--mono);

font-size: var(--fs-md);

font-weight: 600;

}



/* --------------------------------------------------------------------------

11. CLIMATE BANNER

-------------------------------------------------------------------------- */

.climate-banner {

display: block;

}

.climate-region {

display: flex;

align-items: center;

gap: var(--s-3);

margin-bottom: var(--s-3);

}

.climate-region > i {

font-size: var(--fs-xl);

color: var(--text-dim);

flex: none;

}

.climate-sub {

font-family: var(--mono);

font-size: var(--fs-xs);

color: var(--text-faint);

display: block;

margin-bottom: var(--s-1);

}



.location-select {

background: var(--surface-sunk);

border: 1px solid var(--line-strong);

color: var(--text);

padding: 6px 10px;

border-radius: var(--r-sm);

font-size: var(--fs-md);

font-family: var(--sans);

cursor: pointer;

outline: none;

width: 100%;

}

.location-select:hover {

border-color: var(--line-accent);

}



.climate-telemetry-grid {

display: grid;

grid-template-columns: repeat(2, 1fr);

gap: var(--s-2);

}

.c-stat {

background: var(--surface-sunk);

border: 1px solid var(--line);

padding: var(--s-2);

border-radius: var(--r-sm);

display: flex;

flex-direction: column;

gap: 2px;

min-width: 0;

}

.c-label {

font-size: var(--fs-xs);

font-family: var(--mono);

color: var(--text-faint);

display: flex;

align-items: center;

gap: 5px;

}

.c-stat strong {

font-family: var(--mono);

font-size: var(--fs-md);

font-weight: 500;

}



/* Value emphasis — used sparingly, never as pure decoration */

.value-accent {

color: var(--brand);

font-weight: 600;

}

.value-ok {

color: var(--ok);

font-weight: 600;

}

.value-info {

color: var(--info);

font-weight: 600;

}



/* --------------------------------------------------------------------------

12. KPI / GAUGE CARDS

-------------------------------------------------------------------------- */

.card-grid {

display: grid;

grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));

gap: var(--s-3);

}



.gauge-card,

.compact-kpi-card {

min-height: 158px;

}



.gauge-wrap {

position: relative;

width: 104px;

height: 104px;

margin: 0 auto var(--s-2);

}

.radial-gauge {

width: 100%;

height: 100%;

transform: rotate(-90deg);

}

.gauge-bg {

fill: none;

stroke: rgba(255, 255, 255, 0.07);

stroke-width: 14;

}

.gauge-fg {

fill: none;

stroke-width: 14;

stroke-linecap: round;

transition: stroke-dashoffset 0.5s ease;

}



/* Gauge strokes are neutral until the reading itself is notable.

No drop-shadows: glow on a normal reading is noise. */

.gauge-fg.vwc {

stroke: var(--ok);

}

.gauge-fg.pwm {

stroke: var(--info);

}

.gauge-fg.flow {

stroke: var(--brand);

}

.gauge-fg.saved {

stroke: var(--ok);

}



.gauge-center {

position: absolute;

inset: 0;

display: grid;

place-content: center;

text-align: center;

}

.gauge-center strong {

font-family: var(--mono);

font-size: var(--fs-2xl);

font-weight: 600;

letter-spacing: -0.5px;

}

.gauge-center span {

color: var(--text-faint);

font-size: var(--fs-xs);

}



.card-values {

display: grid;

grid-template-columns: 1fr 1fr;

gap: var(--s-1);

}

.card-values > div {

background: var(--surface-sunk);

border: 1px solid var(--line);

border-radius: var(--r-sm);

padding: 6px 8px;

display: grid;

gap: 1px;

}

.card-values span {

color: var(--text-faint);

font-size: var(--fs-xs);

}

.card-values strong {

font-family: var(--mono);

font-size: var(--fs-md);

font-weight: 500;

}



.compact-kpi-value {

display: flex;

align-items: baseline;

justify-content: space-between;

gap: var(--s-2);

margin: var(--s-5) 0 var(--s-3);

}

.compact-kpi-value strong {

font-family: var(--mono);

font-size: var(--fs-2xl);

font-weight: 600;

letter-spacing: -0.6px;

}

.compact-kpi-value span {

color: var(--text-faint);

font-size: var(--fs-xs);

text-align: right;

}



.compact-kpi-meta {

display: flex;

justify-content: space-between;

align-items: center;

margin-top: var(--s-2);

font-family: var(--mono);

font-size: var(--fs-xs);

color: var(--text-faint);

}

.compact-kpi-meta strong {

color: var(--text-dim);

font-size: var(--fs-xs);

}



.kpi-meter {

height: 4px;

border-radius: 999px;

background: rgba(255, 255, 255, 0.06);

overflow: hidden;

}

.kpi-meter span {

display: block;

width: 0;

height: 100%;

background: var(--brand);

transition: width 0.45s ease;

}

.kpi-accent-line {

border-top: 1px solid var(--line);

padding-top: var(--s-2);

color: var(--text-dim);

font-family: var(--mono);

font-size: var(--fs-xs);

}



/* Loading skeleton — better than a bare "--" */

.is-loading .gauge-center strong,

.is-loading .compact-kpi-value strong {

color: var(--text-faint);

}



/* --------------------------------------------------------------------------

13. FLEET / FOCUS KPI BAR (used by views 2-6)

-------------------------------------------------------------------------- */

.fleet-kpi-bar {

display: grid;

grid-template-columns: repeat(4, 1fr);

gap: var(--s-3);

}

.kpi-box {

background: var(--surface-1);

border: 1px solid var(--line);

border-radius: var(--r-md);

padding: var(--s-3) var(--s-4);

display: flex;

flex-direction: column;

gap: var(--s-1);

}

.kpi-label {

font-size: var(--fs-xs);

font-family: var(--mono);

color: var(--text-faint);

display: flex;

align-items: center;

gap: 6px;

}

.kpi-val {

font-family: var(--mono);

font-size: var(--fs-2xl);

font-weight: 600;

letter-spacing: -0.6px;

}

.kpi-val small {

font-size: var(--fs-sm);

color: var(--text-faint);

font-weight: 400;

letter-spacing: 0;

}



.focus-grid {

display: grid;

grid-template-columns: repeat(4, 1fr);

gap: var(--s-3);

margin-top: var(--s-2);

}

.focus-item {

background: var(--surface-sunk);

border: 1px solid var(--line);

border-radius: var(--r-sm);

padding: var(--s-3);

display: flex;

flex-direction: column;

gap: var(--s-1);

}

.focus-item span {

font-size: var(--fs-xs);

color: var(--text-faint);

font-family: var(--mono);

}

.focus-item strong {

font-size: var(--fs-lg);

font-weight: 500;

}



/* --------------------------------------------------------------------------

14. ZONES

-------------------------------------------------------------------------- */

.zones-grid {

display: grid;

grid-template-columns: repeat(6, minmax(0, 1fr));

gap: var(--s-2);

}

.zone-card {

cursor: pointer;

text-align: left;

min-height: 78px;

background: var(--surface-sunk);

border: 1px solid var(--line);

border-radius: var(--r-sm);

padding: var(--s-3);

display: grid;

gap: 2px;

color: var(--text);

transition:

border-color 0.15s ease,

background 0.15s ease;

}

.zone-card:hover {

border-color: var(--line-strong);

}

.zone-card .zone-id {

font-family: var(--mono);

font-size: var(--fs-md);

font-weight: 600;

}

.zone-card .crop-tag {

font-size: var(--fs-xs);

color: var(--text-faint);

}

.zone-card .zone-val {

font-family: var(--mono);

font-size: var(--fs-xl);

font-weight: 600;

}



/* Only out-of-range zones get colour. "Optimal" is the boring default. */

.zone-card.dry {

border-color: rgba(239, 68, 68, 0.45);

}

.zone-card.dry .zone-val {

color: var(--crit);

}

.zone-card.wet {

border-color: rgba(56, 189, 248, 0.45);

}

.zone-card.wet .zone-val {

color: var(--info);

}

.zone-card.optimal .zone-val {

color: var(--text);

}



.zone-card[aria-pressed="true"] {

border-color: var(--brand);

background: rgba(0, 229, 255, 0.07);

}



/* --------------------------------------------------------------------------

15. DIGITAL TWIN

-------------------------------------------------------------------------- */

.twin-card {

min-height: 420px;

}

.twin-grid {

display: grid;

grid-template-columns: 1fr 1.4fr 1fr;

gap: var(--s-4);

align-items: stretch;

min-height: 340px;

}

.twin-unit {

display: grid;

gap: var(--s-2);

align-content: start;

}

.twin-label {

font-size: var(--fs-xs);

color: var(--text-faint);

}

.twin-label em {

font-style: normal;

font-family: var(--mono);

color: var(--text-dim);

margin-left: var(--s-2);

}



.tank {

position: relative;

height: 180px;

border-radius: var(--r-md);

overflow: hidden;

background: var(--surface-sunk);

border: 1px solid var(--line-strong);

}

.tank-fill {

position: absolute;

left: 0;

right: 0;

bottom: 0;

height: 85%;

background: linear-gradient(

180deg,

rgba(0, 229, 255, 0.55),

rgba(0, 229, 255, 0.18)

);

transition: height 0.6s ease;

}

.tank-pct {

position: absolute;

inset: 0;

display: grid;

place-items: center;

font-family: var(--mono);

font-size: var(--fs-lg);

}



.pipe {

position: relative;

height: 40px;

border-radius: 999px;

margin-top: 70px;

background: var(--surface-sunk);

border: 1px solid var(--line-strong);

overflow: hidden;

}

.pipe .pulse {

position: absolute;

top: 50%;

width: 12px;

height: 12px;

border-radius: 50%;

background: var(--brand);

opacity: 0;

transform: translateY(-50%);

}

/* Motion here is meaningful: it only runs when water is actually moving. */

.pipe.flowing .pulse {

animation: flowPulse var(--flow-speed, 1.4s) linear infinite;

}

.pipe .p2 {

animation-delay: 0.45s !important;

}

.pipe .p3 {

animation-delay: 0.9s !important;

}

@keyframes flowPulse {

0% {

left: -20px;

opacity: 0;

}

15% {

opacity: 1;

}

85% {

opacity: 1;

}

100% {

left: calc(100% + 10px);

opacity: 0;

}

}



.soil {

height: 180px;

border-radius: var(--r-md);

border: 1px solid var(--line-strong);

display: grid;

place-items: center;

background: var(--surface-sunk);

transition: background 0.6s ease;

}

.soil.dry {

background: rgba(245, 158, 11, 0.12);

}

.soil.wet {

background: rgba(56, 189, 248, 0.12);

}

.plant {

font-size: 48px;

color: var(--ok);

transition:

color 0.6s ease,

transform 0.6s ease;

}

.soil.dry .plant {

color: var(--warn);

transform: scale(0.94);

}

.soil.wet .plant {

color: var(--info);

}



/* --------------------------------------------------------------------------

16. P&ID SCHEMATIC

-------------------------------------------------------------------------- */

.pid-schematic-wrap {

width: 100%;

height: 280px;

background: var(--surface-sunk);

border: 1px solid var(--line);

border-radius: var(--r-md);

overflow: hidden;

display: flex;

align-items: center;

justify-content: center;

}

.pid-svg {

width: 100%;

height: 100%;

max-height: 280px;

}



.pid-pipe {

fill: none;

stroke: rgba(148, 163, 184, 0.28);

stroke-width: 6;

stroke-linecap: round;

stroke-linejoin: round;

transition: stroke 0.3s ease;

}

.pid-pipe.active-flow {

stroke: var(--brand);

stroke-dasharray: 10, 8;

animation: pidFlow 1.2s linear infinite;

}

@keyframes pidFlow {

from {

stroke-dashoffset: 36;

}

to {

stroke-dashoffset: 0;

}

}



.pid-vessel {

fill: var(--surface-sunk);

stroke: var(--line-strong);

stroke-width: 2.5;

}

.pid-pump {

fill: var(--surface-2);

stroke: var(--line-strong);

stroke-width: 3;

transition: stroke 0.3s ease;

}

.pid-pump.running {

stroke: var(--ok);

}

.pid-impeller {

fill: var(--text-faint);

transition: fill 0.3s ease;

}

.pid-pump.running .pid-impeller {

fill: var(--ok);

}

.pid-signal-line {

stroke: rgba(148, 163, 184, 0.35);

stroke-width: 1.5;

stroke-dasharray: 3, 3;

}

.pid-bubble {

fill: var(--surface-2);

stroke: var(--line-strong);

stroke-width: 2;

}

.pid-bubble-text {

font-family: var(--mono);

font-size: 9px;

font-weight: 700;

fill: var(--text-dim);

text-anchor: middle;

}

.pid-tag-title {

font-family: var(--mono);

font-size: 11px;

font-weight: 700;

fill: var(--text);

text-anchor: middle;

}

.pid-sub-tag {

font-family: var(--mono);

font-size: 9px;

fill: var(--text-faint);

text-anchor: middle;

}

.pid-val-text {

font-family: var(--mono);

font-size: 13px;

font-weight: 700;

fill: var(--text);

text-anchor: middle;

}

.pid-val-text.sm {

font-size: 11px;

fill: var(--text-dim);

}

.pid-valve-body {

fill: var(--surface-2);

stroke: var(--line-strong);

stroke-width: 2;

}

.pid-solenoid {

fill: var(--canvas);

stroke: var(--line-strong);

stroke-width: 1.5;

}

.pid-solenoid-letter {

font-family: var(--mono);

font-size: 9px;

font-weight: 700;

fill: var(--text-dim);

text-anchor: middle;

}

.pid-soil-block {

fill: rgba(16, 185, 129, 0.1);

stroke: rgba(16, 185, 129, 0.4);

stroke-width: 2;

}



/* --------------------------------------------------------------------------

17. MODBUS TABLE (tertiary — reference data, must recede)

-------------------------------------------------------------------------- */

.modbus-table-wrap {

max-height: 380px;

overflow-y: auto;

border: 1px solid var(--line);

border-radius: var(--r-sm);

background: var(--surface-sunk);

}

.modbus-table {

width: 100%;

border-collapse: collapse;

font-family: var(--mono);

font-size: var(--fs-sm);

text-align: left;

}

.modbus-table th {

background: var(--surface-2);

color: var(--text-faint);

padding: var(--s-2) var(--s-3);

border-bottom: 1px solid var(--line-strong);

font-size: var(--fs-xs);

font-weight: 500;

position: sticky;

top: 0;

}

.modbus-table td {

padding: 8px var(--s-3);

border-bottom: 1px solid var(--line);

color: var(--text-dim);

}

.modbus-table tr:hover td {

background: rgba(255, 255, 255, 0.03);

}



/* Column semantics as classes, not inline styles */

.mb-addr {

color: var(--text);

font-weight: 600;

}

.mb-type {

color: var(--text-faint);

}

.mb-tag {

color: var(--text-dim);

}

.mb-hex {

color: var(--info);

}

.mb-val {

color: var(--text);

font-weight: 600;

}

.mb-val.is-active {

color: var(--ok);

}

.mb-val.is-crit {

color: var(--crit);

}



/* --------------------------------------------------------------------------

18. CHARTS

-------------------------------------------------------------------------- */

.chart-card {

min-height: 310px;

}

.chart-wrap {

height: 250px;

}

.chart-wrap canvas {

width: 100% !important;

height: 100% !important;

}

.chart-wrap.tall {

height: 320px;

}

.chart-wrap.short {

height: 220px;

}



.chart-chips {

display: inline-flex;

gap: var(--s-2);

align-items: center;

flex-wrap: wrap;

}

.et0-chip {

font-family: var(--mono);

font-size: var(--fs-xs);

color: var(--text-dim);

border: 1px solid var(--line);

padding: 4px 9px;

border-radius: 999px;

}

.chart-chip-label {

font-family: var(--mono);

font-size: var(--fs-xs);

color: var(--text-faint);

border: 1px solid var(--line);

border-radius: 999px;

padding: 4px 9px;

}



.dsp-grid {

display: grid;

grid-template-columns: repeat(auto-fit, minmax(290px, 1fr));

gap: var(--s-4);

}

.dsp-caption {

font-size: var(--fs-xs);

color: var(--text-faint);

margin-bottom: var(--s-2);

text-align: center;

}



/* --------------------------------------------------------------------------

19. CONTROLS (PID)

-------------------------------------------------------------------------- */

.two-col {

display: grid;

grid-template-columns: 1.25fr 0.75fr;

gap: var(--s-3);

}



.pid-row {

display: grid;

gap: var(--s-2);

padding: var(--s-3) 0;

border-top: 1px solid var(--line);

}

.pid-row:first-of-type {

border-top: 0;

padding-top: 0;

}

.pid-row label {

display: flex;

justify-content: space-between;

font-size: var(--fs-md);

color: var(--text-dim);

}

.pid-row output {

font-family: var(--mono);

color: var(--text);

font-weight: 600;

}

.pid-row small {

color: var(--text-faint);

font-family: var(--mono);

font-size: var(--fs-xs);

}



input[type="range"] {

-webkit-appearance: none;

appearance: none;

width: 100%;

height: 6px;

border-radius: 999px;

background: var(--surface-3);

outline: none;

cursor: pointer;

}

input[type="range"]::-webkit-slider-thumb {

-webkit-appearance: none;

width: 18px;

height: 18px;

border-radius: 50%;

background: var(--surface-2);

border: 2px solid var(--brand);

cursor: pointer;

transition: transform 0.12s ease;

}

input[type="range"]::-webkit-slider-thumb:hover {

transform: scale(1.12);

}

input[type="range"]::-moz-range-thumb {

width: 16px;

height: 16px;

border-radius: 50%;

background: var(--surface-2);

border: 2px solid var(--brand);

cursor: pointer;

}

input[type="range"]:disabled {

cursor: not-allowed;

}

input[type="range"]:disabled::-webkit-slider-thumb {

border-color: var(--text-faint);

cursor: not-allowed;

}



/* Read-only state for unauthorised operators */

body:not(.operator-authorized) .pid-card .pid-row input[type="range"] {

opacity: 0.5;

}



.windup {

margin-left: var(--s-2);

color: var(--text-faint);

}

.windup .dot {

display: inline-block;

width: 7px;

height: 7px;

border-radius: 50%;

background: var(--ok);

margin-left: var(--s-1);

}



.switch {

display: inline-flex;

align-items: center;

gap: var(--s-2);

cursor: pointer;

font-size: var(--fs-xs);

color: var(--text-dim);

font-family: var(--mono);

}

.switch input {

position: absolute;

opacity: 0;

width: 0;

height: 0;

}

.switch .track {

width: 42px;

height: 22px;

border-radius: 999px;

background: var(--surface-3);

border: 1px solid var(--line-strong);

position: relative;

transition:

background 0.2s ease,

border-color 0.2s ease;

}

.switch .thumb {

position: absolute;

top: 2px;

left: 2px;

width: 16px;

height: 16px;

border-radius: 50%;

background: var(--text-faint);

transition:

left 0.2s ease,

background 0.2s ease;

}

.switch input:checked + .track {

background: rgba(245, 158, 11, 0.2);

border-color: rgba(245, 158, 11, 0.55);

}

.switch input:checked + .track .thumb {

left: 22px;

background: var(--warn);

}

.switch input:focus-visible + .track {

outline: 2px solid var(--brand);

outline-offset: 2px;

}



.manual-banner {

display: flex;

align-items: center;

gap: var(--s-2);

font-size: var(--fs-xs);

font-weight: 600;

color: var(--warn);

background: rgba(245, 158, 11, 0.1);

border: 1px solid rgba(245, 158, 11, 0.4);

border-radius: var(--r-sm);

padding: var(--s-2) var(--s-3);

margin-bottom: var(--s-2);

}

.manual-banner[hidden] {

display: none;

}

.pid-card.manual-active {

border-color: rgba(245, 158, 11, 0.45);

}



.rationale-banner {

display: flex;

align-items: flex-start;

gap: var(--s-3);

background: var(--surface-sunk);

border: 1px solid var(--line);

border-radius: var(--r-sm);

padding: var(--s-3) var(--s-4);

font-size: var(--fs-md);

line-height: var(--lh-body);

color: var(--text-dim);

}

.rationale-banner i {

color: var(--text-faint);

font-size: var(--fs-lg);

margin-top: 2px;

}

.rationale-banner.is-ok {

border-color: rgba(16, 185, 129, 0.3);

}

.rationale-banner.is-ok i {

color: var(--ok);

}



/* --------------------------------------------------------------------------

20. BUTTONS

-------------------------------------------------------------------------- */

.muted {

color: var(--text-dim);

font-size: var(--fs-md);

}

.muted.small {

font-size: var(--fs-xs);

margin-top: var(--s-3);

}



.btn-row {

display: grid;

grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));

gap: var(--s-2);

margin-top: var(--s-3);

}



.btn {

border: 1px solid var(--line-strong);

border-radius: var(--r-sm);

padding: 11px var(--s-3);

font-family: var(--sans);

font-weight: 600;

font-size: var(--fs-md);

cursor: pointer;

background: var(--surface-2);

color: var(--text);

display: inline-flex;

align-items: center;

justify-content: center;

gap: var(--s-2);

transition:

background 0.15s ease,

border-color 0.15s ease;

}

.btn:hover {

border-color: var(--line-accent);

}

.btn:active {

transform: translateY(1px);

}

.btn.firing {

border-color: var(--brand);

}



.btn.info {

border-color: var(--line-accent);

color: var(--brand);

}

.btn.info:hover {

background: rgba(0, 229, 255, 0.08);

}

.btn.danger {

border-color: rgba(239, 68, 68, 0.45);

color: #fca5a5;

}

.btn.danger:hover {

background: rgba(239, 68, 68, 0.1);

}

.btn.ghost {

background: transparent;

color: var(--text-dim);

}

.btn.ghost:hover {

color: var(--text);

}



.btn.shutoff {

background: rgba(239, 68, 68, 0.14);

border-color: rgba(239, 68, 68, 0.6);

color: #fecaca;

}

.btn.shutoff:hover {

background: rgba(239, 68, 68, 0.22);

}

.btn.shutoff.armed {

border-color: var(--crit);

animation: criticalPulse 1.4s ease-in-out infinite;

}



.btn-sm {

padding: 6px 12px;

font-size: var(--fs-xs);

font-family: var(--mono);

}



/* --------------------------------------------------------------------------

21. MAP

-------------------------------------------------------------------------- */

.fleet-map-card {

padding: var(--s-3);

}

.fleet-map-container {

height: 520px;

width: 100%;

border-radius: var(--r-sm);

border: 1px solid var(--line);

overflow: hidden;

background: var(--canvas);

}

.map-legend {

display: flex;

align-items: center;

gap: var(--s-3);

font-size: var(--fs-xs);

font-family: var(--mono);

color: var(--text-faint);

}

.legend-dot {

width: 7px;

height: 7px;

border-radius: 50%;

display: inline-block;

}

.legend-dot.nominal {

background: var(--ok);

}

.legend-dot.active {

background: var(--brand);

}



.leaflet-popup-content-wrapper {

background: var(--surface-2) !important;

color: var(--text) !important;

border: 1px solid var(--line-strong) !important;

border-radius: var(--r-sm) !important;

font-family: var(--sans);

}

.leaflet-popup-tip {

background: var(--surface-2) !important;

}

.leaflet-bar {

border: 1px solid var(--line-strong) !important;

border-radius: var(--r-sm) !important;

overflow: hidden;

}

.leaflet-bar a {

background: var(--surface-2) !important;

color: var(--text-dim) !important;

border-bottom: 1px solid var(--line) !important;

}

.leaflet-bar a:hover {

background: var(--surface-3) !important;

color: var(--text) !important;

}

.leaflet-control-layers {

background: var(--surface-2) !important;

border: 1px solid var(--line-strong) !important;

color: var(--text) !important;

border-radius: var(--r-sm) !important;

font-family: var(--sans) !important;

font-size: var(--fs-sm) !important;

padding: var(--s-2) !important;

}

.leaflet-control-layers label {

color: var(--text-dim) !important;

display: flex;

align-items: center;

gap: 6px;

}

.leaflet-control-layers input[type="radio"] {

accent-color: var(--brand);

}



.map-popup strong {

display: block;

margin-bottom: var(--s-1);

color: var(--brand);

font-size: var(--fs-md);

}

.map-popup {

font-size: var(--fs-sm);

line-height: var(--lh-body);

}

.map-popup .popup-status.active {

color: var(--brand);

font-weight: 600;

}

.map-popup .popup-status.nominal {

color: var(--ok);

font-weight: 600;

}



/* --------------------------------------------------------------------------

22. VIEW-SPECIFIC STATE BADGES

-------------------------------------------------------------------------- */

#aiDecisionKpi.hold-active {

color: var(--warn);

}

#aiDecisionKpi.nominal {

color: var(--text);

}



#aiHoldStateBadge {

display: inline-flex;

align-items: center;

padding: 3px 9px;

border-radius: var(--r-sm);

font-family: var(--mono);

font-size: var(--fs-xs);

border: 1px solid var(--line);

color: var(--text-dim);

}

#aiHoldStateBadge.active {

border-color: rgba(245, 158, 11, 0.5);

color: var(--warn);

}

#aiHoldStateBadge.inactive {

border-color: rgba(16, 185, 129, 0.35);

color: var(--ok);

}



/* ISO 10816 zones — colour is the whole point of this badge */

.live-pill.zone-a {

color: var(--ok);

border-color: rgba(16, 185, 129, 0.45);

}

.live-pill.zone-a .status-dot {

background: var(--ok);

}

.live-pill.zone-b {

color: var(--info);

border-color: rgba(56, 189, 248, 0.45);

}

.live-pill.zone-b .status-dot {

background: var(--info);

}

.live-pill.zone-c {

color: var(--warn);

border-color: rgba(245, 158, 11, 0.5);

}

.live-pill.zone-c .status-dot {

background: var(--warn);

}

.live-pill.zone-d {

color: var(--crit);

border-color: rgba(239, 68, 68, 0.6);

animation: criticalPulse 1.4s ease-in-out infinite;

}

.live-pill.zone-d .status-dot {

background: var(--crit);

}



/* --------------------------------------------------------------------------

23. MODALS

-------------------------------------------------------------------------- */

.modal-overlay {

position: fixed;

inset: 0;

z-index: 100;

display: none;

background: rgba(3, 5, 10, 0.78);

backdrop-filter: blur(6px);

align-items: center;

justify-content: center;

padding: var(--s-5);

}

.modal-overlay.open {

display: flex;

}



.modal-card {

width: min(520px, 100%);

background: var(--surface-2);

border: 1px solid var(--line-strong);

border-radius: var(--r-lg);

padding: var(--s-5);

box-shadow: var(--shadow-mod);

animation: modalIn 0.18s ease;

}

.modal-card.narrow {

max-width: 380px;

}

.modal-card.wide {

max-width: 600px;

}

@keyframes modalIn {

from {

transform: translateY(8px);

opacity: 0;

}

to {

transform: none;

opacity: 1;

}

}



.modal-head {

display: flex;

align-items: center;

justify-content: space-between;

margin-bottom: var(--s-4);

font-weight: 600;

font-size: var(--fs-lg);

}

.modal-head i {

color: var(--text-faint);

margin-right: var(--s-2);

}

.modal-close {

display: inline-flex;

width: 32px;

height: 32px;

}

.modal-intro {

color: var(--text-dim);

font-size: var(--fs-md);

margin-bottom: var(--s-3);

}



.field {

display: grid;

gap: var(--s-1);

margin-bottom: var(--s-3);

}

.field label {

font-size: var(--fs-xs);

color: var(--text-faint);

}

.field input,

.field select {

background: var(--surface-sunk);

border: 1px solid var(--line-strong);

color: var(--text);

border-radius: var(--r-sm);

padding: 10px var(--s-3);

font-family: var(--mono);

font-size: var(--fs-md);

width: 100%;

}

.field input.pin {

text-align: center;

font-size: var(--fs-xl);

letter-spacing: 6px;

}



.form-error {

color: var(--crit);

font-size: var(--fs-xs);

margin-bottom: var(--s-2);

}

.form-error[hidden] {

display: none;

}



.modal-actions {

display: flex;

gap: var(--s-2);

justify-content: flex-end;

margin-top: var(--s-4);

}



.terms-body {

max-height: 280px;

overflow-y: auto;

border: 1px solid var(--line);

border-radius: var(--r-sm);

padding: var(--s-4);

background: var(--surface-sunk);

font-size: var(--fs-sm);

line-height: var(--lh-body);

color: var(--text-dim);

display: grid;

gap: var(--s-3);

}

.terms-body h4 {

color: var(--text);

font-size: var(--fs-md);

margin-bottom: var(--s-1);

}

.terms-body .note {

color: var(--text-faint);

font-size: var(--fs-xs);

display: block;

margin-top: var(--s-1);

}



.consent {

display: flex;

gap: var(--s-2);

align-items: center;

margin-top: var(--s-4);

font-size: var(--fs-md);

color: var(--text);

cursor: pointer;

}

.consent input {

width: 17px;

height: 17px;

accent-color: var(--ok);

cursor: pointer;

flex: none;

}



/* --------------------------------------------------------------------------

24. LOGS (tertiary)

-------------------------------------------------------------------------- */

.logs-card {

font-family: var(--mono);

}

.log-list {

list-style: none;

display: grid;

gap: 3px;

max-height: 180px;

overflow: auto;

padding-right: var(--s-1);

}

.log-list li {

background: var(--surface-sunk);

border: 1px solid var(--line);

border-radius: var(--r-sm);

padding: 6px var(--s-2);

font-size: var(--fs-xs);

color: var(--text-dim);

display: flex;

gap: var(--s-2);

}

.log-list li .t {

color: var(--text-faint);

flex: none;

}

.log-list li .src {

font-weight: 600;

flex: none;

}

.log-list li.lvl-ok .src {

color: var(--ok);

}

.log-list li.lvl-info .src {

color: var(--brand);

}

.log-list li.lvl-warn .src {

color: var(--warn);

}

.log-list li.lvl-crit .src {

color: var(--crit);

}



.log-list::-webkit-scrollbar,

.modbus-table-wrap::-webkit-scrollbar,

.terms-body::-webkit-scrollbar {

width: 6px;

}

.log-list::-webkit-scrollbar-thumb,

.modbus-table-wrap::-webkit-scrollbar-thumb,

.terms-body::-webkit-scrollbar-thumb {

background: var(--line-strong);

border-radius: 999px;

}



/* --------------------------------------------------------------------------

25. RESPONSIVE

-------------------------------------------------------------------------- */

@media (max-width: 1350px) {

#viewDashboard.active {

grid-template-columns: minmax(0, 1fr) 286px;

}

.zones-grid {

grid-template-columns: repeat(3, minmax(0, 1fr));

}

.focus-grid,

.fleet-kpi-bar {

grid-template-columns: repeat(2, 1fr);

}

}



@media (max-width: 1050px) {

#viewDashboard.active {

grid-template-columns: 1fr;

grid-template-areas:

"kpis" "safety" "alarms" "twin" "weather"

"ai" "moisture" "pumpflow" "zones" "controls" "logs";

}

.twin-grid {

grid-template-columns: 1fr;

}

.pipe {

margin-top: var(--s-2);

}

}



@media (max-width: 900px) {

.sidebar {

transform: translateX(-105%);

transition: transform 0.22s ease;

}

body.nav-open .sidebar {

transform: none;

}

body.nav-open::after {

content: "";

position: fixed;

inset: 0;

z-index: 45;

background: rgba(0, 0, 0, 0.55);

}

.layout-main {

margin-left: 0;

}

.icon-btn.menu-btn {

display: inline-flex;

}

.two-col {

grid-template-columns: 1fr;

}

.btn-row {

grid-template-columns: 1fr 1fr;

}

}



@media (max-width: 700px) {

.dashboard {

padding: var(--s-3) var(--s-3) 32px;

}

.top-header {

padding: var(--s-2) var(--s-3);

gap: var(--s-2);

}

.header-title p {

display: none;

}

.header-status {

display: none;

}

.telemetry-source-group {

display: none;

}

.card-grid {

grid-template-columns: repeat(2, minmax(0, 1fr));

}

.zones-grid {

grid-template-columns: repeat(2, minmax(0, 1fr));

}

.fleet-kpi-bar,

.focus-grid {

grid-template-columns: 1fr 1fr;

}

.fleet-map-container {

height: 380px;

}

.safety-metrics {

grid-template-columns: 1fr;

}

}



@media (max-width: 460px) {

.card-grid {

grid-template-columns: 1fr;

}

.btn-row {

grid-template-columns: 1fr;

}

.modal-card {

padding: var(--s-4);

}

}



/* ==========================================================================

26. PROFESSIONAL EXTENSIONS

--------------------------------------------------------------------------

Optional components consolidated from the second stylesheet:

- hardware/source badges

- digital-twin mode controls

- AI/MPC state badges

- fleet map / Leaflet theme

- richer but restrained card treatment

These rules intentionally reuse the main token system above.

========================================================================== */



/* Hardware, security and uptime chips */

.firewall-chip,

.uptime-chip,

.btn-usb-link,

.usb-status-chip,

.auth-btn {

display: inline-flex;

align-items: center;

gap: var(--s-2);

font-family: var(--mono);

font-size: var(--fs-xs);

white-space: nowrap;

}



.firewall-chip,

.uptime-chip {

padding: var(--s-2) var(--s-3);

border: 1px solid var(--line-accent);

border-radius: 999px;

color: var(--brand);

background: rgba(0, 229, 255, 0.07);

}



.uptime-chip {

color: var(--brand);

}

.firewall-chip.is-warning {

color: var(--warn);

border-color: rgba(245, 158, 11, 0.45);

}

.firewall-chip.is-ok {

color: var(--ok);

border-color: rgba(16, 185, 129, 0.45);

}



.btn-usb-link {

padding: var(--s-2) var(--s-3);

border: 1px solid rgba(16, 185, 129, 0.55);

border-radius: 999px;

color: #a7f3d0;

background: rgba(16, 185, 129, 0.1);

cursor: pointer;

transition:

background 0.15s ease,

border-color 0.15s ease,

transform 0.15s ease;

}

.btn-usb-link:hover {

background: rgba(16, 185, 129, 0.18);

border-color: var(--ok);

}

.btn-usb-link:active {

transform: translateY(1px);

}



.usb-status-chip {

padding: var(--s-2) var(--s-3);

border: 1px solid rgba(16, 185, 129, 0.4);

border-radius: 999px;

color: var(--ok);

background: rgba(16, 185, 129, 0.08);

}



/* Backwards-compatible dot alias for markup using .pulse-dot. */

.pulse-dot {

width: 8px;

height: 8px;

flex: none;

border-radius: 50%;

background: var(--text-faint);

}

.pulse-dot.sm {

width: 6px;

height: 6px;

}

.connection-badge.online .pulse-dot,

.connection-badge.online #pingDot,

.connection-badge.online .status-dot {

background: var(--ok) !important;

box-shadow:

0 0 0 3px rgba(16, 185, 129, 0.14),

0 0 10px rgba(16, 185, 129, 0.55);

}

.connection-badge.offline .pulse-dot,

.connection-badge.offline #pingDot,

.connection-badge.offline .status-dot {

background: var(--crit) !important;

box-shadow:

0 0 0 3px rgba(239, 68, 68, 0.14),

0 0 10px rgba(239, 68, 68, 0.45);

}

.live-pill .pulse-dot {

background: var(--ok);

}



/* Digital twin toolbar */

.twin-actions {

display: flex;

align-items: center;

gap: var(--s-2);

}

.twin-mode-selector {

display: inline-flex;

gap: var(--s-1);

padding: 3px;

border: 1px solid var(--line-strong);

border-radius: 999px;

background: var(--surface-sunk);

}

.twin-toggle-btn {

display: inline-flex;

align-items: center;

gap: var(--s-1);

padding: var(--s-1) var(--s-3);

border: 1px solid transparent;

border-radius: 999px;

color: var(--text-dim);

background: transparent;

font: 600 var(--fs-xs) var(--sans);

cursor: pointer;

transition:

color 0.15s ease,

background 0.15s ease,

border-color 0.15s ease;

}

.twin-toggle-btn:hover {

color: var(--text);

}

.twin-toggle-btn.active {

color: var(--brand);

border-color: var(--line-accent);

background: rgba(0, 229, 255, 0.1);

}



/* Professional card highlight: visible, not noisy. */

.card.field-grid-section,

.glass-card {

overflow: hidden;

}

.card.field-grid-section::before,

.glass-card::before {

content: "";

position: absolute;

inset: 0 0 auto;

height: 1px;

background: linear-gradient(

90deg,

transparent,

var(--line-accent),

transparent

);

opacity: 0.75;

pointer-events: none;

}



/* AI/MPC status */

#aiDecisionKpi {

transition:

color 0.2s ease,

text-shadow 0.2s ease;

}

#aiDecisionKpi.hold-active {

color: var(--warn);

}

#aiDecisionKpi.nominal {

color: var(--ok);

}



#aiHoldStateBadge {

display: inline-flex;

align-items: center;

gap: var(--s-1);

padding: var(--s-1) var(--s-2);

border: 1px solid var(--line);

border-radius: var(--r-sm);

color: var(--text-dim);

font: var(--fs-xs) var(--mono);

}

#aiHoldStateBadge.active {

color: var(--warn);

border-color: rgba(245, 158, 11, 0.5);

background: rgba(245, 158, 11, 0.08);

}

#aiHoldStateBadge.inactive {

color: var(--ok);

border-color: rgba(16, 185, 129, 0.35);

background: rgba(16, 185, 129, 0.06);

}



#aiBannerRationale {

display: flex;

align-items: flex-start;

gap: var(--s-3);

padding: var(--s-3) var(--s-4);

border: 1px solid var(--line-accent);

border-radius: var(--r-sm);

color: var(--text-dim);

background: rgba(0, 229, 255, 0.05);

line-height: var(--lh-body);

}

#aiBannerRationale i {

color: var(--brand);

font-size: var(--fs-lg);

}



/* ISO 10816 badges: colour is reserved for the state. */

.live-pill.zone-a {

color: var(--ok);

border-color: rgba(16, 185, 129, 0.45);

}

.live-pill.zone-a .status-dot,

.live-pill.zone-a .pulse-dot {

background: var(--ok);

}

.live-pill.zone-b {

color: var(--info);

border-color: rgba(56, 189, 248, 0.45);

}

.live-pill.zone-b .status-dot,

.live-pill.zone-b .pulse-dot {

background: var(--info);

}

.live-pill.zone-c {

color: var(--warn);

border-color: rgba(245, 158, 11, 0.5);

}

.live-pill.zone-c .status-dot,

.live-pill.zone-c .pulse-dot {

background: var(--warn);

}

.live-pill.zone-d {

color: var(--crit);

border-color: rgba(239, 68, 68, 0.6);

animation: criticalPulse 1.4s ease-in-out infinite;

}

.live-pill.zone-d .status-dot,

.live-pill.zone-d .pulse-dot {

background: var(--crit);

}



/* Export action */

#exportCsvBtn {

display: inline-flex;

align-items: center;

gap: var(--s-1);

padding: var(--s-2) var(--s-3);

border: 1px solid var(--line-accent);

border-radius: var(--r-sm);

color: var(--brand);

background: rgba(0, 229, 255, 0.07);

font: var(--fs-xs) var(--mono);

cursor: pointer;

transition:

background 0.15s ease,

border-color 0.15s ease,

transform 0.15s ease;

}

#exportCsvBtn:hover {

background: rgba(0, 229, 255, 0.14);

border-color: var(--brand);

}

#exportCsvBtn:active {

transform: translateY(1px);

}



/* Map / Leaflet dark theme */

.fleet-map-card {

padding: var(--s-3);

}

.fleet-map-container {

width: 100%;

height: 520px;

overflow: hidden;

border: 1px solid var(--line);

border-radius: var(--r-sm);

background: var(--canvas);

}

.map-legend {

display: flex;

align-items: center;

gap: var(--s-3);

color: var(--text-faint);

font: var(--fs-xs) var(--mono);

}

.legend-dot {

width: 7px;

height: 7px;

border-radius: 50%;

display: inline-block;

}

.legend-dot.nominal {

background: var(--ok);

}

.legend-dot.active {

background: var(--brand);

}



.leaflet-popup-content-wrapper,

.leaflet-popup-tip {

color: var(--text) !important;

background: var(--surface-2) !important;

}

.leaflet-popup-content-wrapper {

border: 1px solid var(--line-strong) !important;

border-radius: var(--r-sm) !important;

font-family: var(--sans);

}

.leaflet-bar,

.leaflet-control-layers {

overflow: hidden;

border: 1px solid var(--line-strong) !important;

border-radius: var(--r-sm) !important;

background: var(--surface-2) !important;

}

.leaflet-bar a {

color: var(--text-dim) !important;

background: var(--surface-2) !important;

border-bottom: 1px solid var(--line) !important;

}

.leaflet-bar a:hover {

color: var(--text) !important;

background: var(--surface-3) !important;

}

.leaflet-control-layers {

padding: var(--s-2) !important;

color: var(--text) !important;

font-family: var(--sans) !important;

}

.leaflet-control-layers label {

display: flex;

align-items: center;

gap: var(--s-1);

color: var(--text-dim) !important;

}

.leaflet-control-layers input[type="radio"] {

accent-color: var(--brand);

}



/* Small screens: preserve tap targets and prevent header overflow. */

@media (max-width: 700px) {

.header-meta {

max-width: 58%;

}

.firewall-chip,

.telemetry-source-group,

.uptime-chip {

display: none;

}

.twin-actions {

flex-wrap: wrap;

}

.twin-mode-selector {

max-width: 100%;

overflow-x: auto;

}

.fleet-map-container {

height: 380px;

}

}



@media (prefers-reduced-motion: reduce) {

*,

*::before,

*::after {

animation: none !important;

transition: none !important;

scroll-behavior: auto !important;

}

}



/* --------------------------------------------------------------------------

27. HTML COMPATIBILITY & SEMANTIC HELPERS

-------------------------------------------------------------------------- */

.highlight-cyan {

color: var(--brand);

font-weight: 600;

}

.highlight-wind {

color: var(--info);

font-weight: 600;

}

.highlight-emerald {

color: var(--ok);

font-weight: 600;

}



.icon-brand {

color: var(--brand);

font-size: var(--fs-lg);

}

.icon-warn {

color: var(--warn);

}

.icon-ok {

color: var(--ok);

font-size: var(--fs-lg);

}



.sdg-badge {

display: inline-flex;

align-items: center;

gap: var(--s-2);

padding: var(--s-2) var(--s-3);

border: 1px solid rgba(16, 185, 129, 0.35);

border-radius: var(--r-sm);

color: var(--ok);

background: rgba(16, 185, 129, 0.06);

font: var(--fs-xs) var(--mono);

}

.sdg-badge i {

color: var(--ok);

}



.pulse-satellite {

flex: none;

color: var(--brand);

font-size: var(--fs-xl);

}



.chart-wrap.medium {

height: 300px;

}

.chart-card-spaced {

margin-top: var(--s-4);

}

.focus-grid-spaced {

margin-bottom: var(--s-4);

}

.pin-input {

text-align: center;

font-size: var(--fs-xl) !important;

letter-spacing: 4px;

}

.badge-success {

color: var(--ok);

border-color: rgba(16, 185, 129, 0.4);

}



.terms-body-compact {

max-height: 250px;

padding-right: var(--s-2);

font-size: var(--fs-sm);

line-height: var(--lh-body);

}

.terms-body-compact p {

margin-bottom: var(--s-3);

}

.terms-body-compact strong {

color: var(--brand);

}



/* Respect native button semantics after zone cards become <button>. */

button.zone-card {

font: inherit;

}



ملف public/style.css الذي أعده سامي ممتاز هندسياً، متماسك للغاية، وآمن بنسبة 100% للدمج؛ فهو يحترم كل المعرّفات والفئات التي يعتمد عليها كود app.js وserver.js.

تقييم الكود هندسياً ووظيفياً:
توافق كامل مع المحركات التفاعلية:

صمامات الأمان والإنذارات: احتفظ بفئات .safety-banner.emergency، .degraded، و.nominal مع أنميشن النبض الحرج criticalPulse دون المساس بمنطق إيقاف المضخة.

محاكاة P&ID والتدفق: فئات .active-flow و.flowing متطابقة تماماً مع أحداث الـ WebSocket في app.js.

جداول Modbus وخرائط GIS: التنسيقات مخصصة بدقة لشاشات Modbus وعناصر مكتبة Leaflet الداكنة.

الانسجام مع معايير التحكم الصناعي (ISA-101):

سامي بنى الملف وفق فلسفة واضحة جداً ذكرها في الترويسة: "اللون يحمل حالة وظيفية وليس مجرد ديكور". هذا يحل مخاوف سيرين بشأن إجهاد العين وتشتت المشغل.

النصوص محكومة بحد أدنى للقراءة (11px)، ولوحة الألوان مبنية بنظام Tokens منظم (--canvas, --surface-1, --brand, إلخ).

الملاحظة الوحيدة (نقطة الخلاف البصري):
سامي انحاز بالكامل لرأي سيرين؛ حيث جعل القائمة الجانبية .sidebar والبطاقات مسطحة ومظلمة جداً (#0b1220)، وتخلى تماماً عن اللمسة الجمالية للتوأم الرقمي (Cyber-Twin Gradients) التي ناقشتها مع عبد الحق.

الحل الهندسي الذكي لدمج الرؤيتين:
نقبل الـ PR الخاص بسامي ونعتمد ملفه كأساس متين، ثم نضيف التموج اللوني الخافت (Aurora Gradients) في أعلى وأسفل القائمة الجانبية .sidebar فقط، بحيث نحصل على المظهر المخصص الذي تريده دون كسر الهدوء الصناعي الذي صممه سامي وسيرين.

التعديل المقترح إضافته إلى قسم .sidebar في ملف سامي:
في القسم رقم 3. SIDEBAR، استبدل فئة .sidebar وأضف لها التموجات الخافتة التالية:

CSS
/* --------------------------------------------------------------------------
   3. SIDEBAR (Enhanced with Subtle Cyber Aurora)
   -------------------------------------------------------------------------- */
.sidebar {
  position: fixed;
  inset: 0 auto 0 0;
  width: var(--sidebar-w);
  background: linear-gradient(180deg, #0e1726 0%, #080d18 100%);
  border-right: 1px solid rgba(0, 229, 255, 0.15);
  display: flex;
  flex-direction: column;
  gap: var(--s-5);
  padding: var(--s-5) var(--s-3);
  z-index: 50;
  overflow-y: auto;
  overflow-x: hidden;
}

/* توهج علوي خافت (سيان + زمردي) يكسر الجمود خلف الشعار */
.sidebar::before {
  content: "";
  position: absolute;
  top: -40px;
  left: -30px;
  width: 180px;
  height: 180px;
  background: radial-gradient(circle, rgba(16, 185, 129, 0.18) 0%, rgba(0, 229, 255, 0.08) 50%, transparent 75%);
  filter: blur(30px);
  pointer-events: none;
}

/* توهج سفلي خافت ومريح للعين عند حالة النظام */
.sidebar::after {
  content: "";
  position: absolute;
  bottom: -40px;
  right: -30px;
  width: 180px;
  height: 180px;
  background: radial-gradient(circle, rgba(0, 229, 255, 0.12) 0%, rgba(16, 185, 129, 0.06) 60%, transparent 80%);
  filter: blur(30px);
  pointer-events: none;
}