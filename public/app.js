/* HydroSync v2.0 — real-time SCADA client. Telemetry in, control events out. */
(function () {
  "use strict";

  var FIFO_MAX = 25;
  var CIRC = 502.65; // 2*pi*80 for radial gauges
  var FLOW_MAX = 50; // L/min gauge capacity

  var socket = null;
  var chart = null;
  var labels = [];
  var vwcSeries = [];
  var spSeries = [];
  var booted = false;
  var state = { kp: 2.0, ki: 0.1, kd: 0.5, setpoint: 55.0, manual: false, manualPwm: 0 };

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
        { label: "VWC %", data: [], borderColor: "#00E5FF", backgroundColor: grad,
          fill: true, tension: 0.45, pointRadius: 0, pointHoverRadius: 4, borderWidth: 2.5 },
        { label: "Setpoint %", data: [], borderColor: "#F59E0B", borderDash: [8, 6],
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
    setText("vcwSetpointDisplay", "SP: " + sp.toFixed(1) + "%");
    setRing("vcwProgress", vwc / 100);

    setText("actuatorValue", String(Math.round(pwm)));
    setText("actuatorValueDisplay", Math.round(pwm) + "%");
    setRing("actuatorProgress", pwm / 100);

    setText("flowValue", flow.toFixed(1));
    setText("flowValueDisplay", flow.toFixed(1) + " L/min");
    setRing("flowProgress", flow / FLOW_MAX);
    setText("tempValue", (typeof d.temp === "number" ? d.temp.toFixed(1) : "--") + " C");

    setText("conservationValue", String(Math.round(saved)));
    setText("conservationValueDisplay", Math.round(saved) + "%");
    setRing("conservationProgress", saved / 100);
    setText("errorValue", (err >= 0 ? "+" : "") + err.toFixed(1));

    setText("KpTerm", (+d.pTerm || 0).toFixed(2));
    setText("KiTerm", (+d.iTerm || 0).toFixed(2));
    setText("KdTerm", (+d.dTerm || 0).toFixed(2));

    if (!booted) {
      booted = true;
      state.setpoint = sp;
      if (typeof d.kp === "number") state.kp = d.kp;
      if (typeof d.ki === "number") state.ki = d.ki;
      if (typeof d.kd === "number") state.kd = d.kd;
      syncControls();
      seedChart(vwc, sp);
      log("Telemetry stream established");
    } else {
      pushPoint(vwc, sp);
    }
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

    var toggle = $("manualToggle");
    if (toggle) toggle.addEventListener("change", function (e) {
      state.manual = !!e.target.checked;
      setText("modeLabel", state.manual ? "MANUAL" : "AUTO");
      setText("pidMode", state.manual ? "MANUAL" : "AUTO");
      var row = $("manualRow");
      if (row) row.hidden = !state.manual;
      if (socket && socket.connected)
        socket.emit("client:manual_override", { enabled: state.manual, manualPwm: state.manualPwm });
      log(state.manual ? "Manual override engaged" : "Returned to AUTO PID");
    });

    function disturbance(type) {
      return function () {
        if (socket && socket.connected) socket.emit("client:disturbance", type);
        var badge = $("juryBadge");
        if (badge) badge.textContent = type === "drought" ? "Drought injected — watch recovery…" : type === "rain" ? "Rain injected — watch recovery…" : "Reset requested…";
        log("Disturbance sent: " + type);
      };
    }
    var dr = $("droughtBtn"), ra = $("rainBtn"), rs = $("resetBtn");
    if (dr) dr.addEventListener("click", disturbance("drought"));
    if (ra) ra.addEventListener("click", disturbance("rain"));
    if (rs) rs.addEventListener("click", function () {
      if (socket && socket.connected) {
        socket.emit("client:manual_override", { enabled: false, manualPwm: 0 });
        socket.emit("client:update_setpoint", 55);
        socket.emit("client:update_pid", { kp: 2.0, ki: 0.1, kd: 0.5 });
      }
      state.manual = false;
      var t = $("manualToggle"); if (t) t.checked = false;
      setText("modeLabel", "AUTO"); setText("pidMode", "AUTO");
      var row = $("manualRow"); if (row) row.hidden = true;
      log("Normal reset requested");
    });

    var menu = $("menuBtn");
    if (menu) menu.addEventListener("click", function () { document.body.classList.toggle("nav-open"); });
    var items = document.querySelectorAll(".nav-item");
    Array.prototype.forEach.call(items, function (a) {
      a.addEventListener("click", function () {
        Array.prototype.forEach.call(items, function (b) { b.classList.remove("active"); });
        a.classList.add("active");
        document.body.classList.remove("nav-open");
      });
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
