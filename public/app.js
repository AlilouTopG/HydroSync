/* ==========================================================================
   HydroSync v2.0 Enterprise — Industrial SCADA Client
   Full Integration: Open-Meteo Satellite, Web Serial USB Edge, 
   Safety Interlocks, GIS Satellite Fleet, Predictive AI (MPC) & ISO 10816 Asset Health
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
  var pwmSeries = [];
  var cumWaterL = 0; 
  var booted = false;
  
  var state = { 
    kp: 2.0, ki: 0.1, kd: 0.5, setpoint: 55.0, 
    manual: false, manualPwm: 0, soilType: "loam", 
    tankCapacity: 200, activeZone: "A1" 
  };

  var isOperatorAuthorized = false;
  var aiLastAlert = 0;
  var lastAudioAlert = 0;

  // 🔌 Web Serial API Variables
  var usbPort = null;
  var usbReader = null;
  var isHardwareMode = false;
  var serialLineBuffer = "";

  // 🗺️ GIS Fleet Map Engine Variables
  var mapInstance = null;
  var FLEET_FARMS = [
    {
      id: "setif",
      name: "Sétif High Plains Agro-Hub",
      region: "Sétif Province",
      crop: "Durum Wheat & Cereals",
      area: "520 Hectares",
      lat: 36.19,
      lon: 5.41,
      status: "nominal",
      defaultVwc: 48.0
    },
    {
      id: "biskra",
      name: "Ziban Oasis Greenhouse Complex",
      region: "Biskra Province",
      crop: "Deglet Nour Dates & Early Tomatoes",
      area: "340 Hectares",
      lat: 34.85,
      lon: 5.73,
      status: "active",
      defaultVwc: 64.0
    },
    {
      id: "eloued",
      name: "Oued Souf Pivot Basin",
      region: "El Oued Province",
      crop: "Desert Pivot Tubers (Potatoes)",
      area: "390 Hectares",
      lat: 33.37,
      lon: 6.86,
      status: "nominal",
      defaultVwc: 54.0
    },
    {
      id: "mitidja",
      name: "Mitidja Valley Citrus Orchards",
      region: "Blida / Algiers Province",
      crop: "Citrus Fruits & Olive Groves",
      area: "200 Hectares",
      lat: 36.56,
      lon: 2.91,
      status: "nominal",
      defaultVwc: 59.0
    }
  ];

  // 🧠 Predictive AI & ⚙️ Asset Health Chart Instances
  var horizonChart = null;
  var vibrationChart = null;
  var vibLabels = [];
  var vibSeries = [];

  var CROP_PROFILES = {
    "Wheat": { setpoint: 48.0, kp: 2.2, ki: 0.08, kd: 0.4 },
    "Tomatoes": { setpoint: 65.0, kp: 3.2, ki: 0.16, kd: 0.6 },
    "Olives": { setpoint: 35.0, kp: 1.4, ki: 0.04, kd: 0.3 },
    "Barley": { setpoint: 42.0, kp: 2.0, ki: 0.07, kd: 0.35 },
    "Corn": { setpoint: 60.0, kp: 2.8, ki: 0.12, kd: 0.5 },
    "Potatoes": { setpoint: 55.0, kp: 2.4, ki: 0.10, kd: 0.45 }
  };

  function $(id) { return document.getElementById(id); }

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
    var badge = $("connectionStatus"), dot = $("pingDot"), txt = $("statusText");
    if (!badge || !txt) return;
    badge.classList.toggle("online", !!online);
    badge.classList.toggle("offline", !online);
    txt.textContent = online ? "ONLINE" : "OFFLINE";
    if (dot) {
      dot.style.background = online ? "var(--emerald)" : "var(--danger)";
      dot.style.boxShadow = online ? "0 0 10px rgba(16,185,129,.8)" : "0 0 10px rgba(239,68,68,.8)";
    }
  }

  function setRing(id, frac) {
    var el = $(id);
    if (!el) return;
    frac = Math.max(0, Math.min(1, frac || 0));
    el.style.strokeDashoffset = String(CIRC - CIRC * frac);
  }

  function setText(id, text) {
    var el = $(id);
    if (el) el.innerHTML = text;
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
    var vwc = +d.vwc || 0, sp = +d.setpoint || 0, pwm = +d.pumpDuty || 0;
    var flow = +d.flowRate || 0, saved = +d.waterSaved || 0;
    var err = (typeof d.error === "number") ? d.error : sp - vwc;
    var mTemp = (typeof d.motorTemp === "number") ? d.motorTemp : 24.0;

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
    setText("savedLitersValue", litersSaved.toFixed(1) + " L <span style='color:var(--emerald); margin-left:6px;'><i class='fa-solid fa-sack-dollar'></i> $" + moneySaved + "</span>");
    
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

    // 🧠 Model Predictive Control (MPC) Telemetry Update
    if (d.predictiveAI) {
      updatePredictiveUI(d.predictiveAI);
    }

    // ⚙️ ISO 10816 Asset Health Telemetry Update
    if (d.assetHealth) {
      updateHealthUI(d.assetHealth, mTemp);
    }

    pwmSeries.push(pwm);
    while (pwmSeries.length > FIFO_MAX) pwmSeries.shift();
    cumWaterL += (flow / 60);
    
    if (typeof d.tankCapacityL === "number") state.tankCapacity = d.tankCapacityL;
    if (typeof d.soilType === "string") state.soilType = d.soilType;
    
    updateTwin(vwc, pwm, flow, d);
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
      log("<strong style='color:var(--emerald)'>[SYSTEM]</strong> SCADA Core linked. Open-Meteo Satellite Feed Online.");
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

    if (d.systemHealth === 'EMERGENCY_LOCK') {
      banner.classList.add("emergency");
      if (icon) icon.className = "fa-solid fa-triangle-exclamation";
      if (title) title.textContent = "EMERGENCY INTERLOCK ENGAGED";
      if (desc) desc.textContent = faults.length ? faults[0] : "Critical threshold tripped. Pump isolated.";
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
        log("<strong style='color:var(--cyan)'><i class='fa-solid fa-robot'></i> [AI CO-PILOT]</strong> High output with low response in Sector " + state.activeZone + ". Leak check advised.");
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
   *  🔌 WEB SERIAL API ENGINE (DIRECT USB HARDWARE INTEGRATION)
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

      log("<strong style='color:var(--emerald)'><i class='fa-brands fa-usb'></i> [USB HW]</strong> Serial COM Port linked successfully at 115200 baud.");
      playTone(1000, 'sine', 0.2, 0.1);

      readUSBStream();
    } catch (err) {
      log("<strong style='color:var(--danger)'>[USB ERROR]</strong> Failed to open COM port: " + err.message);
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
      log("<strong style='color:var(--danger)'>[USB DISCONNECT]</strong> Hardware link terminated.");
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
   *  🗺️ MULTI-VIEW NAVIGATION ENGINE (DASHBOARD / FLEET / PREDICTIVE / HEALTH)
   * ========================================================================== */
  function switchView(viewName) {
    var dashView = $("viewDashboard");
    var fleetView = $("viewFleet");
    var predView = $("viewPredictive");
    var healthView = $("viewHealth");
    var navLinks = document.querySelectorAll(".sidebar-nav .nav-item");

    Array.prototype.forEach.call(navLinks, function (btn) {
      btn.classList.toggle("active", btn.getAttribute("data-view") === viewName);
    });

    if (dashView) dashView.hidden = (viewName !== "dashboard");
    if (fleetView) fleetView.hidden = (viewName !== "fleet");
    if (predView) predView.hidden = (viewName !== "predictive");
    if (healthView) healthView.hidden = (viewName !== "health");

    if (viewName === "fleet") {
      setTimeout(function () { initFleetMap(); }, 150);
      log("<strong style='color:var(--cyan)'><i class='fa-solid fa-map-location-dot'></i> [GIS FLEET]</strong> Switched to National Satellite Fleet Overview.");
    } else if (viewName === "predictive") {
      setTimeout(function () { if (horizonChart) horizonChart.resize(); }, 150);
      log("<strong style='color:var(--cyan)'><i class='fa-solid fa-brain'></i> [PREDICTIVE AI]</strong> Switched to Model Predictive Control (MPC) Climate Horizon.");
    } else if (viewName === "health") {
      setTimeout(function () { 
        if (!vibrationChart) initVibrationChart();
        else vibrationChart.resize(); 
      }, 150);
      log("<strong style='color:var(--emerald)'><i class='fa-solid fa-screwdriver-wrench'></i> [ASSET HEALTH]</strong> Switched to ISO 10816 Mechanical Diagnostics Console.");
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

    log("<strong style='color:var(--emerald)'><i class='fa-solid fa-satellite'></i> [FLEET FOCUS]</strong> Linked SCADA to <strong>" + farm.name + "</strong>");
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
            {
              type: "line",
              label: "Rain Probability (%)",
              data: probData,
              borderColor: "#00E5FF",
              backgroundColor: "rgba(0, 229, 255, 0.12)",
              fill: true,
              tension: 0.4,
              yAxisID: "y",
              borderWidth: 2.5,
              pointRadius: 2
            },
            {
              type: "bar",
              label: "Precipitation (mm)",
              data: rainData,
              backgroundColor: "rgba(56, 189, 248, 0.65)",
              borderColor: "#38BDF8",
              borderWidth: 1,
              yAxisID: "y1",
              borderRadius: 4
            },
            {
              type: "line",
              label: "Air Temp (°C)",
              data: tempData,
              borderColor: "#F59E0B",
              borderDash: [4, 4],
              fill: false,
              tension: 0.3,
              yAxisID: "y",
              borderWidth: 1.8,
              pointRadius: 0
            }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: { duration: 0 },
          interaction: { intersect: false, mode: "index" },
          scales: {
            y: {
              min: 0,
              max: 100,
              position: "left",
              ticks: { color: "rgba(232,238,247,.55)", font: { family: "JetBrains Mono", size: 10 } },
              grid: { color: "rgba(255,255,255,.05)" },
              title: { display: true, text: "Probability % / Temp °C", color: "rgba(139,152,179,.8)", font: { size: 10 } }
            },
            y1: {
              min: 0,
              max: Math.max(10, Math.ceil(Math.max.apply(null, rainData.concat([0])) * 1.5)),
              position: "right",
              ticks: { color: "#38BDF8", font: { family: "JetBrains Mono", size: 10 } },
              grid: { drawOnChartArea: false },
              title: { display: true, text: "Rain mm", color: "#38BDF8", font: { size: 10 } }
            },
            x: {
              ticks: { color: "rgba(139,152,179,.8)", font: { family: "JetBrains Mono", size: 9 }, maxTicksLimit: 12 },
              grid: { color: "rgba(255,255,255,.04)" }
            }
          },
          plugins: {
            legend: { labels: { color: "rgba(232,238,247,.75)", font: { size: 11 }, boxWidth: 14 } }
          }
        }
      });
    } else {
      horizonChart.data.labels = hLabels;
      horizonChart.data.datasets[0].data = probData;
      horizonChart.data.datasets[1].data = rainData;
      horizonChart.data.datasets[2].data = tempData;
      horizonChart.options.scales.y1.max = Math.max(10, Math.ceil(Math.max.apply(null, rainData.concat([0])) * 1.5));
      horizonChart.update("none");
    }
  }

  /* ==========================================================================
   *  ⚙️ ISO 10816 PREDICTIVE MAINTENANCE & VIBRATION CHART ENGINE
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
          {
            label: "Vibration RMS (mm/s)",
            data: [],
            borderColor: "#00E5FF",
            backgroundColor: grad,
            fill: true,
            tension: 0.35,
            borderWidth: 2.2,
            pointRadius: 0
          },
          {
            label: "ISO Zone B Limit (1.8 mm/s)",
            data: [],
            borderColor: "#10B981",
            borderDash: [5, 5],
            borderWidth: 1.5,
            fill: false,
            pointRadius: 0
          },
          {
            label: "ISO Zone C Warning (2.8 mm/s)",
            data: [],
            borderColor: "#F59E0B",
            borderDash: [5, 5],
            borderWidth: 1.5,
            fill: false,
            pointRadius: 0
          },
          {
            label: "ISO Zone D Critical (4.5 mm/s)",
            data: [],
            borderColor: "#EF4444",
            borderDash: [4, 4],
            borderWidth: 1.8,
            fill: false,
            pointRadius: 0
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 0 },
        scales: {
          y: {
            min: 0,
            max: 6.0,
            ticks: { color: "rgba(232,238,247,.55)", font: { family: "JetBrains Mono", size: 10 } },
            grid: { color: "rgba(255,255,255,.06)" },
            title: { display: true, text: "Velocity RMS (mm/s)", color: "rgba(139,152,179,.8)", font: { size: 10 } }
          },
          x: {
            ticks: { color: "rgba(139,152,179,.8)", font: { family: "JetBrains Mono", size: 9 }, maxTicksLimit: 8 },
            grid: { color: "rgba(255,255,255,.04)" }
          }
        },
        plugins: {
          legend: { labels: { color: "rgba(232,238,247,.7)", font: { size: 10 }, boxWidth: 14 } }
        }
      }
    });
  }

  function updateHealthUI(ah, motorTemp) {
    if (!ah) return;

    setText("healthIndexKpi", (ah.healthIndex || 98.4).toFixed(1) + "%");
    setText("vibRmsKpi", (ah.vibrationRms || 0.22).toFixed(2) + " <small>mm/s</small>");
    setText("cavitationKpi", (ah.cavitationIndex || 2.1).toFixed(1) + "%");
    setText("rulHoursKpi", Math.round(ah.rulHours || 6580).toLocaleString() + " <small>Hours</small>");

    setText("bearingWearVal", (ah.bearingWearPct || 4.8).toFixed(1) + "%");
    setText("operatingHoursVal", (ah.operatingHoursTotal || 1420.4).toFixed(1) + " Hours");
    setText("maintActionVal", ah.recommendedAction || "NOMINAL_OPERATION");
    setText("maintMotorTempVal", (motorTemp || 24.0).toFixed(1) + "°C");
    setText("maintRationaleText", ah.rationale || "Optimal baseline.");

    // Update ISO Badge
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

    // Push point to Vibration Chart
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

    // 🗺️ Sidebar Multi-View Navigation
    var navDashboard = document.querySelector(".sidebar-nav [data-view='dashboard']");
    var navFleet = $("navFleet");
    var navPredictive = $("navPredictive");
    var navHealth = $("navHealth");

    if (navDashboard) {
      navDashboard.addEventListener("click", function (e) {
        e.preventDefault(); playClick(); switchView("dashboard");
      });
    }

    if (navFleet) {
      navFleet.addEventListener("click", function (e) {
        e.preventDefault(); playClick(); switchView("fleet");
      });
    }

    if (navPredictive) {
      navPredictive.addEventListener("click", function (e) {
        e.preventDefault(); playClick(); switchView("predictive");
      });
    }

    if (navHealth) {
      navHealth.addEventListener("click", function (e) {
        e.preventDefault(); playClick(); switchView("health");
      });
    }

    // Jump from Map directly to Dashboard Control
    var jumpBtn = $("jumpToControlBtn");
    if (jumpBtn) {
      jumpBtn.addEventListener("click", function () {
        playClick(); switchView("dashboard");
      });
    }

    // ⚙️ Service Asset Button (Authorized Operator Action)
    var serviceBtn = $("serviceAssetBtn");
    if (serviceBtn) {
      serviceBtn.addEventListener("click", function () {
        playClick();
        pressFlash(serviceBtn);
        if (!isOperatorAuthorized) {
          openModal("authModal");
          log("<strong style='color:var(--amber)'>[ACCESS DENIED]</strong> Operator authorization required to log preventive maintenance.");
          return;
        }
        if (socket && socket.connected) {
          socket.emit("client:service_asset");
        }
        log("<strong style='color:var(--emerald)'><i class='fa-solid fa-wrench'></i> [MAINTENANCE LOGGED]</strong> Pump overhaul complete: Rotor bearings recalibrated and fatigue reset.");
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
        log("<strong style='color:var(--cyan)'>[MODE]</strong> Switched to Digital Twin Virtual Simulator.");
      });

      usbBtn.addEventListener("click", function () {
        playClick();
        isHardwareMode = true;
        usbBtn.classList.add("active");
        simBtn.classList.remove("active");
        if (connectBtn && !usbPort) connectBtn.hidden = false;
        if (statusChip && usbPort) statusChip.hidden = false;
        log("<strong style='color:var(--emerald)'><i class='fa-brands fa-usb'></i> [MODE]</strong> Physical Hardware Ingestion engaged. Ready for live sensors.");
      });
    }

    if (connectBtn) {
      connectBtn.addEventListener("click", connectUSBHardware);
    }

    // Geolocation Selector
    var locSelect = $("locationSelect");
    if (locSelect) {
      locSelect.addEventListener("change", function (e) {
        var key = e.target.value;
        playClick();
        if (socket && socket.connected) {
          socket.emit("client:set_location", key);
        }
        var locName = e.target.options[e.target.selectedIndex].text;
        log("<strong style='color:var(--cyan)'><i class='fa-solid fa-satellite'></i> [SATELLITE]</strong> Pulling live weather for: <strong>" + locName + "</strong>");
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
    if (dr) dr.addEventListener("click", disturbance("drought", "<span style='color:var(--amber)'>Severe Drought</span>"));
    if (ra) ra.addEventListener("click", disturbance("rain", "<span style='color:var(--cyan)'>Heavy Rain</span>"));
    
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
      log("<strong style='color:var(--danger)'><i class='fa-solid fa-octagon-xmark'></i> [EMERGENCY]</strong> Manual shutoff engaged!");
    });
    
    if (rs) rs.addEventListener("click", function (e) {
      playClick();
      pressFlash(e.currentTarget);
      if (socket && socket.connected) {
        socket.emit("client:manual_override", { enabled: false, manualPwm: 0 });
        socket.emit("client:update_setpoint", 55);
        socket.emit("client:update_pid", { kp: 2.0, ki: 0.1, kd: 0.5 });
      }
      state.manual = false; state.kp = 2.0; state.ki = 0.1; state.kd = 0.5; state.setpoint = 55;
      syncControls();
      var t = $("manualToggle"); if (t) t.checked = false;
      setManualUI(false);
      var shut = $("shutoffBtn"); if (shut) shut.classList.remove("armed");
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

  function openModal(id) {
    var m = $(id); if (!m) return;
    m.classList.add("open"); m.setAttribute("aria-hidden", "false");
  }
  function closeModal(m) {
    if (typeof m === "string") m = $(m); if (!m) return;
    m.classList.remove("open"); m.setAttribute("aria-hidden", "true");
  }
  function syncSettingsForm() {
    var s = $("settingsSetpoint"), c = $("settingsTankCap"), soil = $("soilType");
    if (s) s.value = state.setpoint; if (c) c.value = state.tankCapacity;
    if (soil) soil.value = state.soilType;
  }
  
  function bindModals() {
    var overlays = document.querySelectorAll(".modal-overlay");
    Array.prototype.forEach.call(overlays, function (o) {
      o.addEventListener("click", function (e) { if (e.target === o) closeModal(o); });
      var closers = o.querySelectorAll("[data-close]");
      Array.prototype.forEach.call(closers, function (b) {
        b.addEventListener("click", function () { closeModal(o); });
      });
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
      log("<strong style='color:var(--emerald)'>[SECURITY]</strong> SCADA Console unlocked: Full Operator Access.");
    });

    socket.on("auth:failed", function (data) {
      playEmergencySiren();
      var err = $("authErrorMsg");
      if (err) err.style.display = "block";
      log("<strong style='color:var(--danger)'>[SECURITY]</strong> " + (data.msg || "Invalid Passcode"));
    });

    socket.on("firewall:alert", function (data) {
      playCautionBeep();
      log("<strong style='color:var(--danger)'>[FIREWALL]</strong> " + data.msg);
    });

    window.addEventListener("resize", function () { 
      if (chart) chart.resize(); 
      if (mapInstance) mapInstance.invalidateSize();
      if (horizonChart) horizonChart.resize();
      if (vibrationChart) vibrationChart.resize();
    });
    document.addEventListener("click", function () { initAudio(); }, { once: true });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();