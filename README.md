# HydroSync — Industrial SCADA & Cyber-Physical Digital Twin for Precision Agriculture

[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18.0.0-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Python](https://img.shields.io/badge/Python-3.10%2B-3776AB?logo=python&logoColor=white)](https://python.org/)
[![FastAPI](https://img.shields.io/badge/FastAPI-Edge_AI_Engine-009688?logo=fastapi&logoColor=white)](https://fastapi.tiangolo.com/)
[![Standard](https://img.shields.io/badge/Compliance-ISO_10816_Class_II-blue)](https://www.iso.org/)
[![Safety](https://img.shields.io/badge/Interlocks-IEC_61508--Inspired-orange)](https://www.iec.ch/)
[![Sustainability](https://img.shields.io/badge/Sustainability-UN_SDG_6.4_Aligned-green)](https://sdgs.un.org/goals/goal6)

HydroSync is a high-availability, industrial-grade Supervisory Control and Data Acquisition (SCADA) and Digital Twin platform engineered for high-efficiency precision irrigation, critical asset health monitoring, and closed-loop agro-hydrological control.

---

## 🏗️ System Architecture & Data Flow

HydroSync decouples real-time process monitoring from computationally heavy edge processing via a high-performance IPC bridge:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          HYDROSYNC SCADA ARCHITECTURE                       │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌──────────────┐    WebSocket (1 Hz)    ┌──────────────────────────────┐  │
│  │   FIELD IoT  │ ◄─────────────────────► │      NODE.JS SCADA SERVER    │  │
│  │  (Simulated) │   Telemetry / Commands  │   (Express + Socket.IO)      │  │
│  └──────────────┘                         │                              │  │
│        ▲                                  │  • PID Closed-Loop Control   │  │
│        │   USB Serial / Modbus TCP        │  • Safety Interlocks (IEC    │  │
│        │   (Hardware Bridge)              │    61508-Inspired)           │  │
│        ▼                                  │  • MPC Irrigation Engine     │  │
│  ┌──────────────┐                         │  • GIS Fleet Map (Leaflet)   │  │
│  │  PLC / RTU   │                         │  • ISO 10816 Vibration       │  │
│  │  (Optional)  │                         │    Diagnostics               │  │
│  └──────────────┘                         └──────────────┬───────────────┘  │
│                                                           │                  │
│                                                           ▼                  │
│                                              ┌──────────────────────────────┐ │
│                                              │   PYTHON EDGE AI ENGINE      │ │
│                                              │   (FastAPI + SciPy/NumPy)    │ │
│                                              │                              │ │
│                                              │  • FFT Vibration Analysis    │ │
│                                              │  • Bearing Fault Detection   │ │
│                                              │  • Cavitation Classification │ │
│                                              │  • RUL Prognostics           │ │
│                                              └──────────────────────────────┘ │
│                                                                             │
│                                              ┌──────────────────────────────┐ │
│                                              │   EXTERNAL DATA SOURCES      │ │
│                                              │                              │ │
│                                              │  • Open-Meteo Satellite      │ │
│                                              │    Weather API               │ │
│                                              │  • OpenStreetMap / CartoDB   │ │
│                                              │    GIS Tiles                 │ │
│                                              └──────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## ⚙️ Core Capabilities

### 1. **Closed-Loop PID Control with Anti-Windup**
- Configurable Kp, Ki, Kd with runtime tuning (operator-authorized)
- Anti-reset windup protection for integrator saturation
- Manual/auto bumpless transfer
- Per-zone setpoint management (6 micro-plots: A1–B3)

### 2. **Model Predictive Control (MPC) for Irrigation**
- 24-hour precipitation horizon from Open-Meteo satellite API
- Autonomous rain-hold: defers pumping when P(rain) ≥ 60% or cumulative ≥ 4 mm
- Water savings estimation with financial ROI (DZD/USD)
- Confidence-scored dispatch recommendations

### 3. **Safety Interlocks (IEC 61508-Inspired)**
| Interlock | Trigger | Action | Debounce |
|-----------|---------|--------|----------|
| Dry-Run Protection | Pump duty > 15% & flow ≤ 0.8 L/min | Emergency stop + latch | 4 s |
| Thermal Overload | Motor temp ≥ 85 °C | Emergency stop + latch | Instant |
| Thermal Warning | Motor temp ≥ 75 °C | Alarm only | Instant |
| Vibration Trip | RMS ≥ 7.1 mm/s (ISO 10816 Class II Zone D) | Emergency stop + latch | Instant |
| Vibration Warning | RMS ≥ 2.8 mm/s (ISO 10816 Class II Zone B/C) | Alarm only | Instant |

- Latching trip logic requires operator PIN reset
- Audit trail: every trip logged with timestamp, cause, and operator ID

### 4. **Asset Health & Predictive Maintenance (ISO 10816 Class II)**
- Real-time vibration velocity RMS monitoring
- FFT spectrum analysis via Python Edge AI (1 kHz sampling)
- Bearing wear trending & Remaining Useful Life (RUL) estimation
- Cavitation strain index from pressure pulsation signature
- Maintenance action log with fatigue reset

### 5. **GIS Fleet Map & Multi-Site Telemetry**
- 4 Algerian agro-hubs: Sétif, Biskra, El Oued, Mitidja
- Live satellite weather per site (Open-Meteo)
- Aggregate fleet KPIs: total area, water reserve, health index
- Drill-down to per-farm SCADA console

### 6. **ISA 5.1 P&ID & Modbus TCP Register Map**
- Vector schematic: Tank (TK-101) → Pump (P-101) → Check Valve → Pressure (PT-101) → Flow (FT-101) → Solenoid (XV-101) → Root Zone
- Live Modbus register table (Coils, Input Registers, Holding Registers)
- Address mapping per ISA 5.1 tag convention

### 7. **ESG Water Accounting & Audit Export**
- Sectoral water accounting by crop micro-plot
- Baseline comparison: traditional flood vs. precision dynamic
- CSV industrial audit export (`/api/export-audit.csv`)
- UN SDG 6.4 aligned metrics: efficiency %, energy saved, CO₂ offset

### 8. **Security Hardening**
- `trust proxy` enabled for correct client IP behind reverse proxies
- SHA-256 operator PIN with `crypto.timingSafeEqual` verification
- Rate-limited WebSocket firewall (token bucket)
- Failed-attempt lockout (5 attempts → 15 min)
- CSP, HSTS, X-Frame-Options, X-Content-Type-Options headers
- CORS restricted to known origins (Render, Vercel, localhost)

---

## 🚀 Quick Start

### Prerequisites
- **Node.js ≥ 18.0.0**
- **Python 3.10+** (for Edge AI engine)
- npm / pip

### Installation
```bash
# Clone & install Node dependencies
git clone <repo-url>
cd HydroSync
npm install

# Install Python Edge AI engine (optional but recommended)
cd ai_engine
pip install -r requirements.txt
# Start AI engine on port 8000
python main.py &

# Start SCADA server
cd ..
npm start
```

### Environment Variables
| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | No | `3000` | SCADA server port |
| `NODE_ENV` | No | `development` | `production` enforces OPERATOR_PIN |
| `OPERATOR_PIN` | **Prod only** | `8492` (dev) | SHA-256 hashed at startup |
| `AI_ENGINE_URL` | No | `http://localhost:8000` | Python FastAPI endpoint |

### Access
- **SCADA Console**: `http://localhost:3000`
- **AI Diagnostics**: `http://localhost:3000/api/ai/diagnostics`
- **CSV Audit Export**: `http://localhost:3000/api/export-audit.csv`

---

## 📁 Project Structure

```
HydroSync/
├── server.js                 # Express + Socket.IO SCADA server
├── simulator.js              # Digital twin process simulator
├── package.json
├── core_control/
│   └── mpc_controller.js     # MPC, safety interlocks, ISO 10816
├── ai_engine/
│   ├── main.py               # FastAPI edge AI server
│   ├── vibration_analysis.py # FFT, bearing fault, cavitation
│   └── requirements.txt
├── public/
│   ├── index.html            # Main SCADA HMI (single-page)
│   ├── app.js                # Client telemetry dispatcher & charts
│   ├── charts.js             # Chart.js wrapper (waveform, FFT, horizon)
│   └── style.css             # Industrial dark-theme UI
└── README.md
```

---

## 🔧 Operator Workflow

1. **Observe** — Dashboard loads in `OBSERVER` mode (read-only telemetry)
2. **Authorize** — Click 🔒 lock icon → enter operator PIN → `OPERATOR` mode
3. **Control** — Adjust PID gains, setpoints, manual PWM override
4. **Disturb** — Inject drought/rain/emergency to test closed-loop recovery
5. **Reset** — On safety trip: click 🔒 → enter PIN → `Operator Reset` clears latch
6. **Export** — `Analytics` view → `Export Industrial Audit (CSV)`

---

## 📊 API Reference

### WebSocket Events (Server → Client)
| Event | Payload | Description |
|-------|---------|-------------|
| `telemetry` | Full state object | 1 Hz broadcast |
| `auth:success` | `{ authorized: true }` | PIN accepted |
| `auth:failed` | `{ msg: string }` | PIN rejected |
| `firewall:alert` | `{ type, msg }` | Rate-limit / auth violation |

### WebSocket Events (Client → Server)
| Event | Payload | Auth Required |
|-------|---------|---------------|
| `client:auth` | `string` (PIN) | No |
| `client:operator_reset` | `{ pin }` or `string` | Yes |
| `client:update_pid` | `{ kp, ki, kd }` | Yes |
| `client:update_setpoint` | `number` | No |
| `client:manual_override` | `{ enabled, manualPwm }` | Yes |
| `client:select_zone` | `"A1".."B3"` | No |
| `client:disturbance` | `"drought" \| "rain"` | No |
| `client:set_location` | `"setif" \| "biskra" \| "eloued" \| "mitidja"` | No |
| `client:service_asset` | — | Yes |

### REST Endpoints
| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/ai/diagnostics` | Python AI engine health & diagnostics |
| `GET` | `/api/export-audit.csv` | Industrial CSV audit export |

---

## 🧪 Testing Safety Interlocks

```bash
# 1. Start server
npm start

# 2. Open browser to http://localhost:3000
# 3. Authorize as Operator (default dev PIN: 8492)
# 4. Switch to MANUAL, set PWM to 100%
# 5. Click "Severe Drought" → flow drops to 0
# 6. Wait 4 seconds → Dry-run interlock trips (CRITICAL)
# 7. Click lock → enter PIN → Operator Reset → system returns to AUTO
```

---

## 📜 Compliance & Standards Alignment

| Standard | Scope | HydroSync Implementation |
|----------|-------|--------------------------|
| **ISO 10816-3** | Machine vibration Class II | RMS thresholds: Warning 2.8, Trip 7.1 mm/s |
| **IEC 61508** | Functional safety (SIL-inspired) | Latching trips, dual-channel logic, audit trail |
| **UN SDG 6.4** | Water-use efficiency | MPC rain-hold, per-zone accounting, ESG dashboard |
| **ISA 5.1** | P&ID symbology | Vector schematic with standard tag prefixes |
| **Modbus TCP** | Industrial comms | Register map @ port 502 (simulated) |

> **Note**: HydroSync implements *inspired* safety patterns aligned with these standards for demonstration and competition purposes. It is not a certified SIL-rated safety system.

---

## 🛠️ Development

### Scripts
```bash
npm run dev      # Nodemon auto-reload
npm start        # Production start
```

### Adding a New Agro-Hub
1. Add entry to `FLEET_FARMS` in `public/app.js`
2. Add coordinates to `LOCATION_COORDINATES` in `server.js`
3. Define crop profile in `CROP_PROFILES` (`public/app.js`)

---

## 🤝 Contributing

1. Fork → feature branch → PR
2. Maintain industrial code style: explicit types, defensive checks, audit logs
3. Update `README.md` for new capabilities
4. All safety-critical changes require double-review

---

## 📄 License

MIT License — see `LICENSE` for details.

---

## 🙏 Acknowledgments

- **Open-Meteo** — Free satellite weather API
- **Leaflet + OpenStreetMap/CartoDB** — GIS mapping
- **Chart.js** — Real-time telemetry visualization
- **Socket.IO** — Low-latency WebSocket transport
- **FastAPI + SciPy/NumPy** — Edge AI vibration diagnostics

---

**HydroSync** — *Where cyber meets physical, and every drop counts.*