/* HydroSync v2.0 — real-time SCADA client. Telemetry in, control events out. */
(function () {
  "use strict";

  var FIFO_MAX = 25;
  var CIRC = 502.65; // 2*pi*80 for radial gauges
  var FLOW_MAX = 50; // L/min gauge capacity

  var socket = null;
  var twinTank = 85; // local reservoir % fallback when server tank fields are absent
  var chart = null;
  var labels = [];
  var vwcSeries = [];
  var spSeries = [];
  var pwmSeries = [];
  var cumWaterL = 0; // client-side dispensed-liter estimate for analytics
  var booted = false;
  var state = { kp: 2.0, ki: 0.1, kd: 0.5, setpoint: 55.0, manual: false, manualPwm: 0, soilType: "loam", tankCapacity: 200, maxFlow: 0, activeZone: "A1" };

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
      li.appendChild(document.createTextNode(msg));
      list.prepend(li);
      while (list.children.length > 30) list.removeChild(list.lastChild);
      var count = $("logCount");
      if (count) count.textContent = list.children.length + " events";
    } catch (e) { /* never break UI for logs */ }
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
    if (dot) dot.style.background = online ? "var(--emerald)" : "#64748b";
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
    if (el) el.textContent = text;
  }

  /* ---------- Chart ---------- */
  function initChart() {
    var canvas = $("mainChart");
    if (!canvas || typeof Chart === "undefined") return;
    var ctx = canvas.getContext("2d");
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

  /* ---------- Telemetry ---------- */
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
    setText("savedLitersValue", ((typeof d.waterSavedL === "number") ? d.waterSavedL : 0).toFixed(1) + " L");
    setText("errorValue", "e(t) " + (err >= 0 ? "+" : "") + err.toFixed(1));

    setText("KpTerm", (+d.pTerm || 0).toFixed(2));
    setText("KiTerm", (+d.iTerm || 0).toFixed(2));
    setText("KdTerm", (+d.dTerm || 0).toFixed(2));

    // Session analytics series (FIFO-aligned with chart)
    pwmSeries.push(pwm);
    while (pwmSeries.length > FIFO_MAX) pwmSeries.shift();
    cumWaterL += (flow / 60); // ≈1 s packet
    if (typeof d.tankCapacityL === "number") state.tankCapacity = d.tankCapacityL;
    if (typeof d.soilType === "string") state.soilType = d.soilType;
    updateTwin(vwc, pwm, flow, d);
    renderZones(d.zones, d.activeZoneId);

    if (!booted) {
      booted = true;
      state.setpoint = sp;
      if (typeof d.kp === "number") state.kp = d.kp;
      if (typeof d.ki === "number") state.ki = d.ki;
      if (typeof d.kd === "number") state.kd = d.kd;
      if (typeof d.soilType === "string") state.soilType = d.soilType;
      if (typeof d.tankCapacityL === "number") state.tankCapacity = d.tankCapacityL;
      syncControls();
      syncSettingsForm();
      seedChart(vwc, sp);
      log("Telemetry stream established");
    } else {
      pushPoint(vwc, sp);
    }
  }

  /* ---------- Visual Twin ---------- */
  function updateTwin(vwc, pwm, flow, d) {
    try {
      // Tank: prefer authoritative server volume; fall back to local drain model
      var pct, liters;
      if (d && typeof d.tankVolumeL === "number" && typeof d.tankCapacityL === "number" && d.tankCapacityL > 0) {
        pct = Math.max(0, Math.min(100, (d.tankVolumeL / d.tankCapacityL) * 100));
        liters = d.tankVolumeL;
      } else {
        twinTank = Math.max(5, Math.min(100, twinTank - flow * 0.03 + 0.02));
        pct = twinTank;
        liters = twinTank / 100 * state.tankCapacity;
      }
      var fill = $("twinTankFill");
      if (fill) fill.style.height = pct.toFixed(1) + "%";
      setText("twinTankLevel", Math.round(pct) + "% · " + liters.toFixed(0) + "L");
      // Pipe: animate only when pump is active; speed scales with PWM
      var pipe = $("twinPipe");
      if (pipe) {
        var flowing = pwm > 0.5;
        pipe.classList.toggle("flowing", flowing);
        // faster pulses at higher duty: 2.2s idle-slow → 0.5s full blast
        pipe.style.setProperty("--flow-speed", (2.2 - (Math.min(100, pwm) / 100) * 1.7).toFixed(2) + "s");
      }
      setText("twinPwmLabel", Math.round(pwm) + "% PWM");
      // Soil + plant: dry <30 amber, wet >65 cyan, else healthy emerald
      var soil = $("twinSoil");
      if (soil) {
        soil.classList.toggle("dry", vwc < 30);
        soil.classList.toggle("wet", vwc > 65);
      }
      setText("twinStatus", vwc < 30 ? "DRY — IRRIGATING" : vwc > 65 ? "SATURATED" : "HYDRATED");
    } catch (e) { /* twin visuals must never break telemetry */ }
  }

  /* ---------- Field zones heatmap ---------- */
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
          var cell = document.querySelector('#zonesContainer [data-zone="' + z.id + '"]');
          if (!cell) return;
          var m = Math.max(0, Math.min(100, +z.moisture || 0));
          var val = cell.querySelector(".zone-val");
          if (val) val.textContent = Math.round(m) + "%";
          cell.classList.remove("dry", "optimal", "wet");
          cell.classList.add(zoneBand(m));
          var isActive = z.id === state.activeZone;
          cell.classList.toggle("active", isActive);
          cell.setAttribute("aria-selected", isActive ? "true" : "false");
        })(zones[i]);
      }
      setText("activeZoneBadge", "Active: Zone " + state.activeZone);
      setText("fieldActive", "Zone " + state.activeZone);
    } catch (e) { /* heatmap must never break telemetry */ }
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

  /* ---------- Emitters ---------- */
  function emitPid() {
    if (!socket || !socket.connected) return;
    socket.emit("client:update_pid", { kp: state.kp, ki: state.ki, kd: state.kd });
  }

  function bindControls() {
    function slider(id, fn) {
      var el = $(id);
      if (el) el.addEventListener("input", fn);
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
      if (state.manual) log("[MANUAL] Valve opened to " + state.manualPwm + "%");
    });

    var toggle = $("manualToggle");
    if (toggle) toggle.addEventListener("change", function (e) {
      state.manual = !!e.target.checked;
      setText("modeLabel", state.manual ? "MANUAL" : "AUTO");
      setText("pidMode", state.manual ? "MANUAL" : "AUTO");
      var row = $("manualRow");
      if (row) row.hidden = !state.manual;
      var banner = $("manualBanner");
      if (banner) banner.hidden = !state.manual;
      var pidCard = document.querySelector(".pid-card");
      if (pidCard) pidCard.classList.toggle("manual-active", state.manual);
      var shut = $("shutoffBtn");
      if (shut) shut.classList.toggle("armed", false);
      if (socket && socket.connected)
        socket.emit("client:manual_override", { enabled: state.manual, manualPwm: state.manualPwm });
      log(state.manual ? "[MANUAL] Override engaged — valve at " + state.manualPwm + "%" : "[AUTO] Returned to PID control");
    });

    function pressFlash(el) {
      if (!el) return;
      el.classList.add("firing");
      setTimeout(function () { el.classList.remove("firing"); }, 320);
    }
    function disturbance(type, label) {
      return function (e) {
        pressFlash(e && e.currentTarget);
        if (socket && socket.connected) socket.emit("client:disturbance", type);
        var badge = $("juryBadge");
        if (badge) badge.textContent = label + " — watch recovery…";
        log("[WEATHER] " + label + " simulated");
      };
    }
    var zc = $("zonesContainer");
    if (zc) zc.addEventListener("click", function (e) {
      var t = e.target;
      var card = (t && t.closest) ? t.closest(".zone-card[data-zone]") : null;
      if (!card) return;
      var id = card.getAttribute("data-zone");
      if (!id || id === state.activeZone) return;
      if (socket && socket.connected) socket.emit("client:select_zone", id);
      var val = card.querySelector(".zone-val");
      log("[DISPATCH] Switched focus to Sector " + id + " - Moisture: " + (val ? val.textContent : "--"));
    });

    var dr = $("droughtBtn"), ra = $("rainBtn"), rs = $("resetBtn"), shutoff = $("shutoffBtn");
    if (dr) dr.addEventListener("click", disturbance("drought", "Severe drought"));
    if (ra) ra.addEventListener("click", disturbance("rain", "Heavy rain"));
    if (shutoff) shutoff.addEventListener("click", function (e) {
      pressFlash(e.currentTarget);
      shutoff.classList.add("armed");
      state.manual = true;
      state.manualPwm = 0;
      var t = $("manualToggle"); if (t) t.checked = true;
      setText("modeLabel", "MANUAL"); setText("pidMode", "MANUAL");
      var row = $("manualRow"); if (row) { row.hidden = false; }
      var banner = $("manualBanner"); if (banner) banner.hidden = false;
      var pidCard = document.querySelector(".pid-card");
      if (pidCard) pidCard.classList.add("manual-active");
      var pwm = $("manualPwmSlider"); if (pwm) pwm.value = 0;
      setText("manualPwmValue", "0%");
      if (socket && socket.connected) socket.emit("client:manual_override", { enabled: true, manualPwm: 0 });
      log("[EMERGENCY] Shutoff engaged — valve closed");
    });
    if (rs) rs.addEventListener("click", function (e) {
      pressFlash(e.currentTarget);
      if (socket && socket.connected) {
        socket.emit("client:manual_override", { enabled: false, manualPwm: 0 });
        socket.emit("client:update_setpoint", 55);
        socket.emit("client:update_pid", { kp: 2.0, ki: 0.1, kd: 0.5 });
      }
      state.manual = false;
      state.kp = 2.0; state.ki = 0.1; state.kd = 0.5; state.setpoint = 55;
      syncControls();
      var t = $("manualToggle"); if (t) t.checked = false;
      setText("modeLabel", "AUTO"); setText("pidMode", "AUTO");
      var row = $("manualRow"); if (row) row.hidden = true;
      var banner = $("manualBanner"); if (banner) banner.hidden = true;
      var pidCard = document.querySelector(".pid-card");
      if (pidCard) pidCard.classList.remove("manual-active");
      var shut = $("shutoffBtn"); if (shut) shut.classList.remove("armed");
      log("[SYSTEM] Normal reset — defaults restored");
    });

    bindModals();

    var menu = $("menuBtn");
    if (menu) menu.addEventListener("click", function () { document.body.classList.toggle("nav-open"); });
    var items = document.querySelectorAll(".nav-item");
    Array.prototype.forEach.call(items, function (a) {
      a.addEventListener("click", function (e) {
        var modal = a.getAttribute("data-modal");
        var view = a.getAttribute("data-view");
        if (modal) {
          e.preventDefault();
          if (modal === "analyticsModal") fillAnalytics();
          openModal(modal);
          document.body.classList.remove("nav-open");
          return;
        }
        Array.prototype.forEach.call(items, function (b) { b.classList.remove("active"); });
        a.classList.add("active");
        document.body.classList.remove("nav-open");
        if (view === "analytics") fillAnalyticsFlash();
      });
    });
  }

  /* ---------- Modals ---------- */
  function openModal(id) {
    var m = $(id);
    if (!m) return;
    m.classList.add("open");
    m.setAttribute("aria-hidden", "false");
  }
  function closeModal(m) {
    if (typeof m === "string") m = $(m);
    if (!m) return;
    m.classList.remove("open");
    m.setAttribute("aria-hidden", "true");
  }
  function syncSettingsForm() {
    var s = $("settingsSetpoint"), c = $("settingsTankCap"), soil = $("soilType"), mf = $("settingsMaxFlow");
    if (s) s.value = state.setpoint;
    if (c) c.value = state.tankCapacity;
    if (soil) soil.value = state.soilType;
    if (mf) mf.value = state.maxFlow;
  }
  function fillAnalytics() {
    function avg(a) {
      if (!a.length) return 0;
      var s = 0, i;
      for (i = 0; i < a.length; i++) s += a[i];
      return s / a.length;
    }
    var n = vwcSeries.length;
    var mn = n ? Math.min.apply(null, vwcSeries) : 0;
    var mx = n ? Math.max.apply(null, vwcSeries) : 0;
    setText("statSamples", String(n));
    setText("statVwc", n ? avg(vwcSeries).toFixed(1) + " / " + mn.toFixed(1) + " / " + mx.toFixed(1) + " %" : "--");
    setText("statPwm", pwmSeries.length ? avg(pwmSeries).toFixed(1) + " %" : "--");
    setText("statWater", cumWaterL.toFixed(2) + " L dispensed");
    var up = $("uptimeTimer");
    setText("statUptime", up ? up.textContent : "--");
  }
  function fillAnalyticsFlash() {
    fillAnalytics();
    openModal("analyticsModal");
  }
  function bindModals() {
    var overlays = document.querySelectorAll(".modal-overlay");
    Array.prototype.forEach.call(overlays, function (o) {
      o.addEventListener("click", function (e) {
        if (e.target === o) closeModal(o);
      });
      var closers = o.querySelectorAll("[data-close]");
      Array.prototype.forEach.call(closers, function (b) {
        b.addEventListener("click", function () { closeModal(o); });
      });
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        Array.prototype.forEach.call(overlays, function (o) { closeModal(o); });
      }
    });
    var save = $("settingsSave");
    if (save) save.addEventListener("click", function () {
      var s = $("settingsSetpoint"), c = $("settingsTankCap"), soil = $("soilType"), mf = $("settingsMaxFlow");
      var sp = s ? Math.max(0, Math.min(100, parseFloat(s.value) || state.setpoint)) : state.setpoint;
      var cap = c ? Math.max(20, Math.min(2000, parseFloat(c.value) || state.tankCapacity)) : state.tankCapacity;
      var st = soil && soil.value ? soil.value : state.soilType;
      var maxF = mf && mf.value !== "" ? Math.max(0, Math.min(50, parseFloat(mf.value) || 0)) : 0;
      state.setpoint = sp; state.tankCapacity = cap; state.soilType = st; state.maxFlow = maxF;
      setText("setpointValue", sp.toFixed(1) + "%");
      var spSlider = $("setpointSlider");
      if (spSlider) spSlider.value = sp;
      if (socket && socket.connected) {
        socket.emit("client:update_settings", { setpoint: sp, tankCapacityL: cap, soilType: st, maxFlowL: maxF });
        socket.emit("client:update_setpoint", sp);
      }
      closeModal("settingsModal");
      log("[SETTINGS] Target=" + sp.toFixed(1) + "% · Tank=" + cap + "L · Soil=" + st + " · MaxFlow=" + (maxF > 0 ? maxF + "L/min" : "uncapped"));
    });
    var accept = $("consentAccept");
    if (accept) accept.addEventListener("click", function () {
      var checked = $("consentCheck");
      var ok = checked ? !!checked.checked : true;
      closeModal("termsModal");
      log(ok ? "[COMPLIANCE] Data-logging consent recorded" : "[COMPLIANCE] Terms viewed — consent declined");
    });
  }

  /* ---------- Boot ---------- */
  function boot() {
    initChart();
    bindControls();
    setStatus(false);
    try {
      socket = io();
    } catch (e) {
      log("Socket.io failed to load");
      return;
    }
    socket.on("connect", function () { setStatus(true); log("Connected to HydroSync server"); });
    socket.on("disconnect", function () { setStatus(false); log("Disconnected from server"); });
    socket.on("connect_error", function () { setStatus(false); });
    socket.on("telemetry", onTelemetry);
    window.addEventListener("resize", function () { if (chart) chart.resize(); });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
