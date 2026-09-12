/* ==========================================================================
   HydroSync v2.0 Enterprise — Advanced SCADA Client
   Features: AI Co-Pilot, Watchdog Failsafe, ROI Calculator, Multi-Zone &
             Agronomic Crop Profiles Engine
   ========================================================================== */
(function () {
  "use strict";

  var FIFO_MAX = 25;
  var CIRC = 502.65; // 2*pi*80 for radial gauges
  var FLOW_MAX = 50; // L/min gauge capacity
  var WATER_PRICE = 0.045; // Cost per liter saved ($) for ROI calculation

  var socket = null;
  var twinTank = 85; 
  var chart = null;
  var labels = [];
  var vwcSeries = [];
  var spSeries = [];
  var pwmSeries = [];
  var cumWaterL = 0; 
  var booted = false;
  
  // Advanced State Tracking
  var state = { 
    kp: 2.0, 
    ki: 0.1, 
    kd: 0.5, 
    setpoint: 55.0, 
    manual: false, 
    manualPwm: 0, 
    soilType: "loam", 
    tankCapacity: 200, 
    maxFlow: 0, 
    activeZone: "A1" 
  };
  var watchdogTripped = false;
  var aiLastAlert = 0;

  // 🌾 Agronomic Crop Profiles Database (Biological Setpoints & Tuning)
  var CROP_PROFILES = {
    "Wheat": { setpoint: 48.0, kp: 2.2, ki: 0.08, kd: 0.4, note: "Cereal grain — balanced drainage requirement" },
    "Tomatoes": { setpoint: 65.0, kp: 3.2, ki: 0.16, kd: 0.6, note: "High hydration demand, sensitive to deficit" },
    "Olives": { setpoint: 35.0, kp: 1.4, ki: 0.04, kd: 0.3, note: "Deep-root tree — drought tolerant, low budget" },
    "Barley": { setpoint: 42.0, kp: 2.0, ki: 0.07, kd: 0.35, note: "Hardy dryland crop — low water footprint" },
    "Corn": { setpoint: 60.0, kp: 2.8, ki: 0.12, kd: 0.5, note: "High evapotranspiration rate, rapid depletion" },
    "Potatoes": { setpoint: 55.0, kp: 2.4, ki: 0.10, kd: 0.45, note: "Tuber crop — requires balanced, stable hydration" }
  };

  function $(id) { return document.getElementById(id); }

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
    } catch (e) { /* keep UI stable */ }
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
    var beat = $("heartbeatPulse");
    if (beat) beat.style.opacity = online ? "1" : "0.25";
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

  /* ---------- Chart ---------- */
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

  /* ---------- Telemetry Processor & AI ---------- */
  function onTelemetry(d) {
    if (!d || typeof d !== "object") return;
    var vwc = +d.vwc || 0, sp = +d.setpoint || 0, pwm = +d.pumpDuty || 0;
    var flow = +d.flowRate || 0, saved = +d.waterSaved || 0;
    var err = (typeof d.error === "number") ? d.error : sp - vwc;

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
    setText("tempValue", (typeof d.temp === "number" ? d.temp.toFixed(1) : "--") + " C");
    setText("et0Value", "ET0 " + ((typeof d.et0 === "number") ? d.et0.toFixed(2) : "--") + " mm/day");

    setText("conservationValue", String(Math.round(saved)));
    setText("conservationValueDisplay", Math.round(saved) + "%");
    setRing("conservationProgress", saved / 100);
    
    // Financial ROI Calculation
    var litersSaved = (typeof d.waterSavedL === "number") ? d.waterSavedL : 0;
    var moneySaved = (litersSaved * WATER_PRICE).toFixed(3);
    setText("savedLitersValue", litersSaved.toFixed(1) + " L <span style='color:var(--emerald); margin-left:6px;'><i class='fa-solid fa-sack-dollar'></i> $" + moneySaved + "</span>");
    
    setText("errorValue", "e(t) " + (err >= 0 ? "+" : "") + err.toFixed(1));
    setText("KpTerm", (+d.pTerm || 0).toFixed(2));
    setText("KiTerm", (+d.iTerm || 0).toFixed(2));
    setText("KdTerm", (+d.dTerm || 0).toFixed(2));

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
      log("<strong style='color:var(--emerald)'>[SYSTEM]</strong> Telemetry stream established successfully.");
    } else {
      pushPoint(vwc, sp);
    }
  }

  /* ---------- AI Agronomist Co-Pilot ---------- */
  function runAIAnalyst(vwc, sp, pwm, flow) {
    var now = Date.now();
    if (now - aiLastAlert > 20000) {
      if (pwm > 85 && vwc < sp - 15) {
        log("<strong style='color:var(--cyan)'><i class='fa-solid fa-robot'></i> [AI CO-PILOT]</strong> High output detected with low moisture response. Suspected hydraulic pipe leak or rapid drainage in Zone " + state.activeZone + ".");
        aiLastAlert = now;
      } else if (vwc > 85) {
        log("<strong style='color:var(--cyan)'><i class='fa-solid fa-robot'></i> [AI CO-PILOT]</strong> Soil saturation critical. Decreasing Target Setpoint is recommended to protect crop root structure.");
        aiLastAlert = now;
      }
    }
  }

  /* ---------- Visual Twin & Watchdog ---------- */
  function updateTwin(vwc, pwm, flow, d) {
    try {
      var pct, liters;
      if (d && typeof d.tankVolumeL === "number" && typeof d.tankCapacityL === "number" && d.tankCapacityL > 0) {
        pct = Math.max(0, Math.min(100, (d.tankVolumeL / d.tankCapacityL) * 100));
        liters = d.tankVolumeL;
      } else {
        twinTank = Math.max(5, Math.min(100, twinTank - flow * 0.03 + 0.02));
        pct = twinTank;
        liters = twinTank / 100 * state.tankCapacity;
      }

      // Hardware Watchdog: Dry-Run Failsafe
      if (pct <= 5.0 && !watchdogTripped) {
        watchdogTripped = true;
        state.manual = true;
        state.manualPwm = 0;
        setManualUI(true);
        if (socket && socket.connected) {
          socket.emit("client:manual_override", { enabled: true, manualPwm: 0 });
        }
        log("<strong style='color:var(--danger)'><i class='fa-solid fa-triangle-exclamation'></i> [WATCHDOG]</strong> Tank level critical (<5%). Emergency shutoff engaged to prevent pump cavitation.");
        var shutoff = $("shutoffBtn"); if (shutoff) shutoff.classList.add("armed");
      } else if (pct > 10 && watchdogTripped) {
        watchdogTripped = false;
        log("<strong style='color:var(--emerald)'>[WATCHDOG]</strong> Tank volume recovered. Interlock cleared.");
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

  /* ---------- Field Zones Heatmap ---------- */
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
          var isActive = z.id === state.activeZone;
          card.classList.toggle("active", isActive);
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

  /* ---------- Controls & Binds ---------- */
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
      if (state.manual && socket && socket.connected)
        socket.emit("client:manual_override", { enabled: true, manualPwm: state.manualPwm });
    });

    var pwmSlider = $("manualPwmSlider");
    if (pwmSlider) pwmSlider.addEventListener("change", function () {
      if (state.manual) log("<strong style='color:var(--amber)'>[MANUAL]</strong> Valve opened to " + state.manualPwm + "%");
    });

    var toggle = $("manualToggle");
    if (toggle) toggle.addEventListener("change", function (e) {
      state.manual = !!e.target.checked;
      setManualUI(state.manual);
      var shut = $("shutoffBtn"); if (shut) shut.classList.toggle("armed", false);
      if (socket && socket.connected)
        socket.emit("client:manual_override", { enabled: state.manual, manualPwm: state.manualPwm });
      log(state.manual ? "<strong style='color:var(--amber)'>[MANUAL]</strong> Override engaged — valve at " + state.manualPwm + "%" : "<strong style='color:var(--emerald)'>[AUTO]</strong> Returned to AI PID control");
    });

    // 🌾 Interactive Micro-Plots Zone Selection with Crop Profiles Engine
    var zc = $("zonesContainer");
    if (zc) zc.addEventListener("click", function (e) {
      var t = e.target;
      var card = (t && t.closest) ? t.closest(".zone-card[data-zone]") : null;
      if (!card) return;
      var id = card.getAttribute("data-zone");
      if (!id) return;

      var cropTag = card.querySelector(".crop-tag");
      var cropName = cropTag ? cropTag.textContent.trim() : "Wheat";
      var profile = CROP_PROFILES[cropName] || CROP_PROFILES["Wheat"];

      // Update local state with agronomic profile
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

      log("<strong style='color:var(--emerald)'><i class='fa-solid fa-seedling'></i> [AGRONOMIST]</strong> Switched focus to Sector " + id + " (<strong>" + cropName + "</strong>). Applied optimal target: " + profile.setpoint.toFixed(1) + "% (" + profile.note + ")");
    });

    function disturbance(type, label) {
      return function (e) {
        pressFlash(e && e.currentTarget);
        if (socket && socket.connected) socket.emit("client:disturbance", type);
        log("<strong>[WEATHER]</strong> " + label + " injected.");
      };
    }
    
    var dr = $("droughtBtn"), ra = $("rainBtn"), rs = $("resetBtn"), shutoff = $("shutoffBtn");
    if (dr) dr.addEventListener("click", disturbance("drought", "<span style='color:var(--amber)'>Severe Drought</span>"));
    if (ra) ra.addEventListener("click", disturbance("rain", "<span style='color:var(--cyan)'>Heavy Rain</span>"));
    
    if (shutoff) shutoff.addEventListener("click", function (e) {
      pressFlash(e.currentTarget);
      shutoff.classList.add("armed");
      state.manual = true; state.manualPwm = 0;
      var t = $("manualToggle"); if (t) t.checked = true;
      setManualUI(true);
      var pwm = $("manualPwmSlider"); if (pwm) pwm.value = 0;
      setText("manualPwmValue", "0%");
      if (socket && socket.connected) socket.emit("client:manual_override", { enabled: true, manualPwm: 0 });
      log("<strong style='color:var(--danger)'><i class='fa-solid fa-octagon-xmark'></i> [EMERGENCY]</strong> Manual shutoff engaged!");
    });
    
    if (rs) rs.addEventListener("click", function (e) {
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
      watchdogTripped = false;
      log("<strong style='color:var(--emerald)'><i class='fa-solid fa-rotate-right'></i> [SYSTEM]</strong> Normal reset complete.");
    });

    bindModals();
  }

  /* ---------- Modals ---------- */
  function openModal(id) {
    var m = $(id); if (!m) return;
    m.classList.add("open"); m.setAttribute("aria-hidden", "false");
  }
  function closeModal(m) {
    if (typeof m === "string") m = $(m); if (!m) return;
    m.classList.remove("open"); m.setAttribute("aria-hidden", "true");
  }
  function syncSettingsForm() {
    var s = $("settingsSetpoint"), c = $("settingsTankCap"), soil = $("soilType"), mf = $("settingsMaxFlow");
    if (s) s.value = state.setpoint; if (c) c.value = state.tankCapacity;
    if (soil) soil.value = state.soilType; if (mf) mf.value = state.maxFlow;
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
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") Array.prototype.forEach.call(overlays, function (o) { closeModal(o); });
    });
    
    var save = $("settingsSave");
    if (save) save.addEventListener("click", function () {
      pressFlash(save);
      var s = $("settingsSetpoint"), c = $("settingsTankCap"), soil = $("soilType"), mf = $("settingsMaxFlow");
      var sp = s ? Math.max(0, Math.min(100, parseFloat(s.value) || state.setpoint)) : state.setpoint;
      var cap = c ? Math.max(20, Math.min(2000, parseFloat(c.value) || state.tankCapacity)) : state.tankCapacity;
      var st = soil && soil.value ? soil.value : state.soilType;
      var maxF = mf && mf.value !== "" ? Math.max(0, Math.min(50, parseFloat(mf.value) || 0)) : 0;
      state.setpoint = sp; state.tankCapacity = cap; state.soilType = st; state.maxFlow = maxF;
      setText("setpointValue", sp.toFixed(1) + "%");
      var spSlider = $("setpointSlider"); if (spSlider) spSlider.value = sp;
      if (socket && socket.connected) {
        socket.emit("client:update_settings", { setpoint: sp, tankCapacityL: cap, soilType: st, maxFlowL: maxF });
        socket.emit("client:update_setpoint", sp);
      }
      closeModal("settingsModal");
      log("<strong style='color:var(--cyan)'>[CONFIG]</strong> Applied: Target=" + sp.toFixed(1) + "% · Tank=" + cap + "L · Soil=" + st.toUpperCase());
    });
    
    var accept = $("consentAccept");
    if (accept) accept.addEventListener("click", function () {
      closeModal("termsModal");
      log("<strong style='color:var(--emerald)'>[COMPLIANCE]</strong> Enterprise Data-logging consent recorded.");
    });
  }

  /* ---------- Boot ---------- */
  function boot() {
    initChart();
    bindControls();
    setStatus(false);
    var socketScript = typeof io !== "undefined";
    if (!socketScript) {
      log("Socket.io library not found.");
      return;
    }
    try {
      socket = io({ transports: ["websocket", "polling"], reconnectionAttempts: 10 });
    } catch (e) {
      return;
    }
    socket.on("connect", function () { setStatus(true); });
    socket.on("disconnect", function () { setStatus(false); });
    socket.on("connect_error", function () { setStatus(false); });
    socket.on("telemetry", onTelemetry);
    window.addEventListener("resize", function () { if (chart) chart.resize(); });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();