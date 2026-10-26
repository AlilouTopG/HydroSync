# HydroSync — Industrial SCADA & Cyber-Physical Digital Twin for Precision Agriculture

[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18.0.0-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Python](https://img.shields.io/badge/Python-3.10%2B-3776AB?logo=python&logoColor=white)](https://python.org/)
[![FastAPI](https://img.shields.io/badge/FastAPI-Edge_AI_Engine-009688?logo=fastapi&logoColor=white)](https://fastapi.tiangolo.com/)
[![Standard](https://img.shields.io/badge/Compliance-ISO_10816_Class_II-blue)](https://www.iso.org/)
[![Safety](https://img.shields.io/badge/Interlocks-IEC_61508--Inspired-orange)](https://www.iec.ch/)
[![Sustainability](https://img.shields.io/badge/Sustainability-UN_SDG_6.4_Aligned-green)](https://sdgs.un.org/goals/goal6)

This README is the repository overview for reviewers and contributors. The
[AI Engine README](ai_engine/README.md) covers the Python inference service,
model inputs, and its current evaluation results.

## Overview

HydroSync is a simulated SCADA and digital-twin system for precision irrigation.
It combines a Node.js dashboard and control server, a pump-and-field simulator,
TimescaleDB telemetry storage, and a Python AI service. The platform is built
for enterprise-grade industrial automation, cyber-physical twinning, and
precision agriculture decision support across Algerian agro-hubs.

### What the system does

- **Monitor:** streams simulator telemetry to a web dashboard over Socket.IO (1 Hz).
- **Control:** runs PID irrigation control, supports manual operation, and applies
  safety interlocks. Operator mode is unlocked via the master operator PIN.
- **Simulate:** models pump operation, vibration, temperature, tank level,
  irrigation conditions, and equipment faults.
- **Analyze:** extracts vibration features and calls the AI service for
  diagnostics and Task 1 / Task 2 / Task 3 classification outputs.
- **Persist:** stores telemetry and experiment metadata in TimescaleDB.
- **Evaluate:** runs tagged Demo Mode scenarios and scores measurement rows
  belonging to a selected run.
- **Copilot:** Google Gemini AI Co-Pilot for natural-language telemetry analysis
  and an AI Test Lab multi-agent pipeline for bounded simulator observations.

---

## 🏗️ System Architecture & Data Flow

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
│                                              │  • Task 1 / 2 / 3 ML Models  │ │
│                                              └──────────────────────────────┘ │
│                                                                             │
│                                              ┌──────────────────────────────┐ │
│                                              │   EXTERNAL DATA SOURCES      │ │
│                                              │                              │ │
│                                              │  • Open-Meteo Satellite      │ │
│                                              │    Weather API               │ │
│                                              │  • OpenStreetMap / CartoDB   │ │
│                                              │    GIS Tiles                 │ │
│                                              │  • Google Gemini (Co-Pilot)  │ │
│                                              └──────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Core System Architecture & Features

| # | Feature | Description |
|---|---------|-------------|
| 1 | **GIS Fleet Map Engine** | Tracks national agricultural hubs in Algeria (Sétif, Biskra, El Oued, Mitidja) with Leaflet.js satellite imagery. |
| 2 | **Open-Meteo Satellite Climate Integration** | Real-time air temperature, wind speed, humidity, and ET0 evapotranspiration sync per site. |
| 3 | **Model Predictive Control (MPC)** | Autonomous 24-hour horizon forecasting and rain-hold logic (defers pumping when P(rain) ≥ 60% or cumulative ≥ 4 mm). |
| 4 | **ISO 10816 Asset Health & DSP** | Real-time time-domain waveform tracking and FFT frequency spectrum analysis for pump vibration, bearing wear, and RUL estimation. |
| 5 | **Safety Interlocks (IEC 61508-Inspired)** | Dry-run protection, thermal overload, and vibration trips requiring operator reset. Latching logic. |
| 6 | **Role-Based Security & Authorization** | Default Observer mode (read-only). Operator mode unlocked via master PIN `1962` (secured via `crypto.timingSafeEqual`). |

---

## 📋 Project Structure

```
HydroSync/
├── server.js                         # Express and Socket.IO SCADA server
├── simulator.js                      # Pump, field, and vibration simulator
├── package.json                      # Node scripts and dependencies
├── compose.yml                       # Local TimescaleDB service
├── .env                              # Environment variables (GEMINI_API_KEY, OPERATOR_PIN, etc.)
├── README.md                         # Project overview and local setup
├── core_control/
│   └── mpc_controller.js             # Irrigation control and safety logic (evaluateSafety, calculateIrrigationDuty, resetSafetyState)
├── database/
│   ├── schema.sql                    # TimescaleDB schema (experiments, telemetry, vibration axes, fault events)
│   ├── db.js                         # PostgreSQL connection pool (pg)
│   ├── telemetryCollector.js         # Experiment and telemetry persistence
│   ├── autoCollector.js              # Dataset collection workflows
│   ├── demoMode.js                   # Full and quick simulator sweeps
│   ├── conditionSetup.js             # Scenario initialization
│   └── vibrationAnalysis.js          # Shared six-feature waveform extraction (Node FFT)
├── ai_engine/
│   ├── main.py                       # FastAPI AI service
│   ├── ml_predictor.py               # Active Task 1/2/3 inference (HistGradientBoosting + Random Forests)
│   ├── requirements.txt              # Python runtime dependencies
│   ├── ml_models/
│   │   ├── hydrosync_task1_model.joblib # Active Task 1 HGB model
│   │   ├── hydrosync_task1_config.json # Task 1 features and threshold
│   │   ├── task2_rf_model.pkl          # Active Task 2 model
│   │   ├── task2_label_encoder.pkl
│   │   ├── task3_rf_model.pkl          # Active Task 3 model
│   │   └── task3_label_encoder.pkl
│   ├── tests/
│   │   ├── test_ml_predictor.py
│   │   └── test_vibration_snapshot.py
│   └── README.md                     # AI service-specific documentation
├── ml/
│   ├── evaluate_quick_demo.py        # Run-isolated simulator evaluation
│   ├── evaluate_demo_models.py       # Run-isolated Task 1/2/3 evaluation
│   ├── inference.py                  # Legacy inference path
│   └── ...
├── ai_agent/
│   ├── agent.js                      # HydroSync AI Co-Pilot agent
│   ├── tools.js                      # Read-only tools for the agent
│   ├── conversationStore.js          # Per-session chat memory
│   ├── mlPredictionStore.js          # ML prediction freshness store
│   ├── testLabStore.js               # Test Lab run state machine
│   ├── testLabWorkflow.js            # Test Lab multi-agent workflow
│   ├── vibrationSnapshot.js          # Vibration snapshot cache
│   └── *.test.js                     # Unit tests for all ai_agent modules
├── scripts/
│   └── download_models.ps1           # Checksum-verifies active model archive download
├── public/
│   ├── index.html                    # SCADA dashboard (7 views + modals)
│   ├── app.js                        # UI and telemetry client (IIFE architecture)
│   ├── charts.js                     # Telemetry and vibration charts (Chart.js v4.4.1)
│   ├── style.css                     # Dashboard styles
│   ├── extracted-inline.css          # Extracted inline styles
│   ├── favicon.svg
│   └── images/
├── tests/
│   └── demoMode.test.js              # Demo Mode unit tests
├── export_multiaxis_dataset.js       # Telemetry-to-CSV export
├── rebuild_task1_dataset.js          # Task 1 waveform dataset rebuild
├── test_bridge.js                    # Integration test bridge
└── audit_bundle.txt                  # Consolidated source audit bundle
```

Model binaries are distributed separately from Git in the versioned
`hydrosync-ml-artifacts-v1.zip` archive. After cloning, download and verify the
archive into the paths above with:

```powershell
.\scripts\download_models.ps1
```

The archive contains only the active Task 1 model/config, Task 2 model/encoder,
and Task 3 model/encoder. It excludes datasets, generated evaluation output,
caches, and the legacy Task 1 Random Forest model.

---

## 🔐 Security & Authorization

### Role-Based Access Control

HydroSync enforces a default **Observer (read-only)** mode. All actuator and
control commands require **Operator** authorization, unlocked by entering the
master operator PIN.

| Role | Access | Default State |
|------|--------|---------------|
| Observer | Read-only telemetry, dashboard viewing | Active by default |
| Operator | Full control: PID tuning, manual override, setpoint, fault injection, reset, service | Locked until PIN entered |

### Master Operator PIN

The master operator PIN is **`1962`**.

Configure it via the `OPERATOR_PIN` environment variable:

```bash
# .env
OPERATOR_PIN=1962
```

- In **development**, if `OPERATOR_PIN` is unset, the server falls back to a
  hardcoded development default. Set `OPERATOR_PIN=1962` in `.env` to use the
  production master PIN.
- In **production**, `OPERATOR_PIN` **must** be set; the server refuses to start
  otherwise (`server.js` throws if `OPERATOR_PIN` is missing in production).
- PIN verification uses SHA-256 hashing and `crypto.timingSafeEqual` to prevent
  timing attacks.
- Failed attempts are tracked per IP: 5 failures trigger a 2-minute lockout.
- An auth budget caps failures at 60 per 60-second window.

### Security Hardening (server.js)

- SHA-256 operator PIN with `crypto.timingSafeEqual` verification
- Rate-limited WebSocket firewall (token bucket)
- Failed-attempt lockout (5 attempts → 2-minute IP lockout)
- Auth budget (60 fails per 60 seconds)
- CSP, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`,
  `X-XSS-Protection`, `Referrer-Policy: strict-origin-when-cross-origin`
- `app.disable('x-powered-by')`, `trust proxy` for correct client IP extraction
- CORS restricted to known origins (Render, localhost in development)
- Per-IP token bucket on the Gemini chat route to prevent quota abuse

---

## 🦺 Safety Interlocks (IEC 61508-Inspired)

Interlock logic lives in `core_control/mpc_controller.js` and is evaluated
every telemetry tick (1 Hz). Trips are **latching** and require an Operator PIN
reset to clear.

| Interlock | Trigger | Action | Debounce |
|-----------|---------|--------|----------|
| Dry-Run Protection | Pump duty > 15% & flow ≤ 0.8 L/min | Emergency stop + latch | 4 s |
| Thermal Overload | Motor temp ≥ 85 °C | Emergency stop + latch | Instant |
| Thermal Warning | Motor temp ≥ 75 °C | Alarm only | Instant |
| Vibration Trip | RMS ≥ 4.5 mm/s (ISO 10816 Class II Zone D) | Emergency stop + latch | Instant |
| Vibration Warning | RMS ≥ 2.8 mm/s (Zone C) | Alarm only | Instant |

The simulator (`simulator.js`) also enforces interlocks at the physics layer:
`dryRun`, `thermalTrip`, `pipeBurst`, `floodRisk`, `sensorFault`.

### Operator Reset

After a safety trip, the system remains locked until an authorized Operator
resets it:

1. Click the 🔒 lock icon → enter PIN `1962` → **OPERATOR** mode unlocked.
2. Click **Reset** (or use the Test Lab / modal) → emits `client:operator_reset`.
3. Server clears `isSafetyTripped`, calls `resetSafetyState()`, returns pump to AUTO.

**Emergency Stop** is intentionally **not** PIN-gated: industrial safety
requires instant pump cutoff regardless of authorization state. The PIN is
reserved for Reset and configuration changes.

---

## 👷 Operator Workflow

### 1. Observe (Observer Mode)

1. Start the server (`npm start`) and open `http://localhost:3000`.
2. The dashboard loads in **OBSERVER** mode (read-only telemetry).
3. Review live gauges, GIS Fleet Map, MPC horizon, Asset Health, ESG KPIs.

### 2. Authorize (Unlock Operator Mode)

1. Click the 🔒 **OBSERVER** button in the top header (or any control requiring auth).
2. The **SCADA Master Authorization** modal opens.
3. Enter the operator PIN: **`1962`**.
4. Click **Unlock Console**.
5. The button changes to **OPERATOR** (unlocked); PID sliders and controls become active.

### 3. Control

- **PID Tuning:** Adjust Kp / Ki / Kd sliders (operator-authorized). Changes emit
  `client:update_pid` over WebSocket.
- **Setpoint:** Adjust Target Moisture slider or open System Settings → apply
  `client:update_setpoint` / `client:update_settings`.
- **Manual Override:** Toggle MANUAL → set Manual PWM → emits
  `client:manual_override`. Blocked while the system is in a SAFETY_TRIP lock.
- **Zone Selection:** Click a micro-plot (A1–B3) → `client:select_zone`.
- **Service Asset:** Click **Log Preventive Maintenance** → resets bearing wear,
  cavitation, health index, RUL (operator-authorized).

### 4. Disturb / Test

- **Severe Drought / Heavy Rain:** Inject physical disturbances to test
  closed-loop PID self-recovery (`client:disturbance`).
- **Emergency Shutoff:** Instant pump cutoff (`client:emergency_stop`, no PIN).
- **Fault Injection:** Inject Bearing / Overheat / Clear faults (operator-authorized).
- **Location:** Switch among Sétif, Biskra, El Oued, Mitidja → fetches live
  Open-Meteo weather (`client:set_location`).

### 5. Reset (After Safety Trip)

1. Wait for the interlock to trip (banner shows CRITICAL).
2. Click 🔒 → enter PIN `1962` → OPERATOR mode.
3. Click **Reset** → `client:operator_reset` clears the latch and restores AUTO.

### 6. Export

- Click **Export Industrial Audit (CSV)** → downloads `/api/export-audit.csv`
  with the rolling 150-cycle audit history.

### 7. AI Co-Pilot

- Click the 🤖 floating button → open the SCADA AI Co-Pilot chat.
- Ask about telemetry, diagnostics, or asset health. Requires `GEMINI_API_KEY`.

### 8. AI Test Lab

- Open AI Test Lab from the sidebar.
- Requires an existing Co-Pilot session (`/api/sessions`).
- Submit a test objective → Planner proposes a bounded normal-operation
  observation → review plan → **Approve & Execute** → Executor samples telemetry
  → Evaluator reports verdict.

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
| `client:inject_fault` | `"bearing" \| "overheat" \| "clear"` | Yes |
| `client:emergency_stop` | — | No |
| `client:update_settings` | `{ setpoint, tankCapacity, soilType }` | Yes |

### REST Endpoints

Node.js routes use `http://localhost:3000`; Python AI routes use `http://localhost:8000`.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` (3000) | Serve the web dashboard |
| `GET` | `/api/ai/diagnostics` | AI engine diagnostics and latest vibration features |
| `GET` | `/api/ai/vibration` | Latest waveform, FFT, and features |
| `GET` | `/api/ai/vibration/multi-axis` | Latest multi-axis vibration data |
| `GET` | `/api/export-audit.csv` | Download in-memory SCADA audit history as CSV |
| `POST` | `/api/chat` | AI Co-Pilot message; requires `GEMINI_API_KEY` |
| `POST` | `/api/sessions` | Create a Co-Pilot chat session |
| `GET` | `/api/test-lab/agents` | Test Lab agent roles and scenarios |
| `POST` | `/api/test-lab/runs` | Propose a test plan (`{ sessionId, objective }`) |
| `GET` | `/api/test-lab/runs?sessionId=...` | List runs for a session |
| `GET` | `/api/test-lab/runs/:id?sessionId=...` | Read a run |
| `POST` | `/api/test-lab/runs/:id/approve` | Record human approval bound to plan hash |
| `POST` | `/api/test-lab/runs/:id/cancel` | Cancel a run |
| `POST` | `/api/test-lab/runs/:id/execute` | Execute an approved run |
| `POST` | `/api/demo/start` | Start full Demo Mode sweep |
| `POST` | `/api/demo/quick/start` | Start quick Demo Mode sweep |
| `POST` | `/api/demo/stop` | Stop Demo Mode |
| `GET` | `/api/demo/status` | Read Demo Mode status |
| `GET` | `/` (8000) | Python AI service health check |
| `GET` | `/diagnostics` (8000) | Python AI service diagnostics |
| `POST` | `/api/predict_anomaly` (8000) | Basic vibration/temp/flow threshold check |
| `POST` | `/vibration` (8000) | Analyze submitted waveform |
| `GET` | `/vibration/latest` (8000) | Latest vibration analysis |
| `POST` | `/predict` (8000) | Task 1 / 2 / 3 classification |

---

## ◇ Database and Docker

HydroSync uses **TimescaleDB (PostgreSQL 17)** for persistent telemetry:

- `experiments` records collection runs and their metadata.
- `telemetry` stores timestamped pump state, vibration measurements and
  waveforms, ground-truth labels, model outputs, and flexible JSON metadata.
  It is a TimescaleDB hypertable partitioned by time.
- `telemetry_vibration_axes` stores synchronized per-axis waveform records;
  it is also a time-partitioned hypertable.
- `fault_events`, indexes, summary views, and a continuous aggregate support
  event history and telemetry queries.

The schema is defined in [`database/schema.sql`](database/schema.sql). The Node
server writes experiments and telemetry through `database/telemetryCollector.js`;
the Python AI engine returns predictions to Node, which stores them alongside
the corresponding telemetry. Model files and CSV datasets remain project files,
not data stored in this database.

Docker Compose is used **only to run the local database container**. In
[`compose.yml`](compose.yml), service `timescaledb` uses the
`timescale/timescaledb:latest-pg17` image, exposes container port `5432` as
host port `5433`, and mounts the named volume `hydrosync-timescaledb-data`.
The Node.js server and Python AI engine are started separately as local
processes; they are not Docker services in this Compose setup. The named
volume preserves database contents when the container is stopped or removed.
Use `docker compose down -v` only when you intentionally want to delete that
persistent database volume.

### Local Database Setup

```powershell
# 1. Start TimescaleDB
docker compose up -d timescaledb
docker compose ps

# 2. Wait for readiness
do {
  Start-Sleep -Seconds 2
  docker exec hydrosync-timescaledb pg_isready -U hydrosync -d hydrosync
} until ($LASTEXITCODE -eq 0)

# 3. Apply schema (first-time only; do not rerun against an initialized DB)
Get-Content .\database\schema.sql -Raw | docker exec -i hydrosync-timescaledb psql -U hydrosync -d hydrosync
```

Database connection defaults (matching `compose.yml` and `database/db.js`):
- Host: `localhost`, Port: `5433`, Database: `hydrosync`
- User: `hydrosync`, Password: `hydrosync_dev_password`

Override via `DATABASE_URL` or `TIMESCALEDB_*` environment variables.

---

## ◇ Current AI Integration

### AI Co-Pilot

The dashboard Co-Pilot keeps up to 12 recent user/reply turns per conversation
in Node.js memory. Conversations use separate opaque session IDs, expire after
30 minutes of inactivity, and are bounded to 1,000 live sessions. Memory is
process-local and is lost when the server restarts. The Co-Pilot uses
`GEMINI_API_KEY` and the model configured by `GEMINI_MODEL` (default:
`gemini-3.1-flash-lite-preview`).

### ML Prediction Engine

The Python service exposes `/predict`. It returns:

- **Task 1:** top-level state: `healthy`, `fault`, or `operating_condition`.
  The active model is a HistGradientBoosting classifier loaded from
  `ai_engine/ml_models/hydrosync_task1_model.joblib`; its configuration is
  `hydrosync_task1_config.json`. A configured healthy-probability threshold
  of `0.38` is used.
- **Task 2:** fault subtype prediction.
- **Task 3:** operating-condition prediction.

All three heads receive the same nine ordered inputs:
`vibration_rms`, `dominant_frequency_hz`, `one_x_amplitude`,
`two_x_amplitude`, `two_x_to_one_x_ratio`, `spectral_energy`,
`motor_temp_c`, `pwm_actual`, `pwm_target`.

Task 2 and Task 3 outputs are produced independently; Task 1 is the top-level
state. See the [AI Engine README](ai_engine/README.md) for inference details
and evaluation limitations.

### AI Test Lab

The Test Lab adds five separately invoked Gemini roles: Test Coordinator, Test
Planner, Diagnostic Analyst, Test Executor, and Evaluator/Reporter. Each has a
distinct instruction set, structured schema, tool allowlist, and model setting.
Configure models with `AI_TEST_LAB_COORDINATOR_MODEL`,
`AI_TEST_LAB_PLANNER_MODEL`, `AI_TEST_LAB_DIAGNOSTIC_MODEL`,
`AI_TEST_LAB_EXECUTOR_MODEL`, and `AI_TEST_LAB_EVALUATOR_MODEL`; defaults are
`gemini-3.8-flash` for the Coordinator and `gemini-3.5-flash-lite` for the
other roles. They reuse `GEMINI_API_KEY`.

The current supported scenario is a bounded (5–30 second) read-only normal
operation observation. Fault testing requires a separate interlock-preserving
simulator scenario. Run state and session ownership are in memory and expire
after ten minutes; an operator approval expires after two minutes and is
single-use.

---

## 🧪 Testing Safety Interlocks

```bash
# 1. Start server
npm start

# 2. Open browser to http://localhost:3000
# 3. Authorize as Operator (master PIN: 1962)
# 4. Switch to MANUAL, set PWM to 100%
# 5. Click "Severe Drought" → flow drops to 0
# 6. Wait 4 seconds → Dry-run interlock trips (CRITICAL)
# 7. Click lock → enter PIN 1962 → Operator Reset → system returns to AUTO
```

Run Demo Mode tests:

```bash
npm test
# or
node --test tests/demoMode.test.js
```

Run ai_agent unit tests:

```bash
node --test ai_agent/*.test.js
```

Run AI engine tests (with venv activated):

```powershell
& .\ai_engine\.venv\Scripts\python.exe -m pytest ai_engine/tests/
```

---

## ⚙️ Core Capabilities

### 1. Closed-Loop PID Control with Anti-Windup
- Configurable Kp, Ki, Kd with runtime tuning (operator-authorized)
- Anti-reset windup protection for integrator saturation
- Manual/auto bumpless transfer
- Per-zone setpoint management (6 micro-plots: A1–B3)

### 2. Model Predictive Control (MPC) for Irrigation
- 24-hour precipitation horizon from Open-Meteo satellite API
- Autonomous rain-hold: defers pumping when P(rain) ≥ 60% or cumulative ≥ 4 mm
- Water savings estimation with financial ROI (DZD/USD)
- Confidence-scored dispatch recommendations

### 3. Safety Interlocks (IEC 61508-Inspired)
Latching trip logic requires operator PIN reset. Audit trail: every trip logged
with timestamp, cause, and operator ID.

### 4. Asset Health & Predictive Maintenance (ISO 10816 Class II)
- Real-time vibration velocity RMS monitoring
- FFT spectrum analysis via Python Edge AI (1 kHz sampling)
- Bearing wear trending & Remaining Useful Life (RUL) estimation
- Cavitation strain index from pressure pulsation signature
- Maintenance action log with fatigue reset

### 5. GIS Fleet Map & Multi-Site Telemetry
- 4 Algerian agro-hubs: Sétif, Biskra, El Oued, Mitidja
- Live satellite weather per site (Open-Meteo)
- Aggregate fleet KPIs: total area, water reserve, health index
- Drill-down to per-farm SCADA console

### 6. ISA 5.1 P&ID & Modbus TCP Register Map
- Vector schematic: Tank (TK-101) → Pump (P-101) → Check Valve → Pressure (PT-101) → Flow (FT-101) → Solenoid (XV-101) → Root Zone
- Live Modbus register table (Coils, Input Registers, Holding Registers)
- Address mapping per ISA 5.1 tag convention

### 7. ESG Water Accounting & Audit Export
- Sectoral water accounting by crop micro-plot
- Baseline comparison: traditional flood vs. precision dynamic
- CSV industrial audit export (`/api/export-audit.csv`)
- UN SDG 6.4 aligned metrics: efficiency %, energy saved, CO₂ offset

### 8. Security Hardening
- `trust proxy` enabled for correct client IP behind reverse proxies
- SHA-256 operator PIN with `crypto.timingSafeEqual` verification
- Rate-limited WebSocket firewall (token bucket)
- Failed-attempt lockout (5 attempts → 15 min)
- CSP, HSTS, X-Frame-Options, X-Content-Type-Options headers
- CORS restricted to known origins (Render, Vercel, localhost)

---

## ◇ Run Locally (Windows PowerShell)

### Prerequisites

- Node.js 18+
- Python 3.10+
- npm
- Docker Desktop with Docker Compose

### 1. Clone the repository

```powershell
git clone https://github.com/AlilouTopG/HydroSync.git
Set-Location .\HydroSync
```

### 2. Install Node dependencies

```powershell
npm install
```

> Note: `@google/genai` is listed in `package.json` but is not imported at
> runtime; `server.js` uses `@google/generative-ai` (installed). This is a
> harmless manifest discrepancy.

### 3. Model artifacts (required before starting the AI engine)

The model files are too large and separately versioned, so they are not stored
in Git. Download the checksum-verified v1 archive and install its six active
artifacts before starting the Python service:

```powershell
.\scripts\download_models.ps1
```

### 4. Start the database container

```powershell
docker compose up -d timescaledb
docker compose ps
do {
  Start-Sleep -Seconds 2
  docker exec hydrosync-timescaledb pg_isready -U hydrosync -d hydrosync
} until ($LASTEXITCODE -eq 0)
Get-Content .\database\schema.sql -Raw | docker exec -i hydrosync-timescaledb psql -U hydrosync -d hydrosync
```

### 5. Configure environment

Create/update `.env` at the repository root:

```ini
GEMINI_API_KEY=your_gemini_api_key
OPERATOR_PIN=1962
PORT=3000
AI_ENGINE_URL=http://127.0.0.1:8000
```

### 6. Install Python AI dependencies

```powershell
Set-Location .\ai_engine
py -3.12 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
```

### 7. Start the Python AI engine

```powershell
python main.py
```

The AI API listens on `http://localhost:8000` by default. Keep this process
running.

### 8. Start the Node.js SCADA server

Open a third PowerShell window at the repository root:

```powershell
npm start
```

`npm start` runs `node server.js`. The dashboard is at `http://localhost:3000`.

---

## ◇ Evaluation Snapshot

Full-sweep simulator run `dc48648b-53e8-4ed4-9362-36cf771d5929` scored 1,337 valid
measurement rows with the active predictor:

| Head | Rows | Accuracy | Balanced accuracy | Macro-F1 |
|------|------:|---------:|------------------:|---------:|
| Task 1 | 1,337 | 0.8534 | 0.8068 | 0.8049 |
| Task 2 | 743 | 0.8587 | 0.8579 | 0.8667 |
| Task 3 | 445 | 1.0000 | 1.0000 | 1.0000 |

These are repeated simulator telemetry rows, **not independent experiments**.
Do not use this run to tune thresholds or alter ground-truth labels.

---

## 📜 Compliance & Standards Alignment

| Standard | Scope | HydroSync Implementation |
|----------|-------|--------------------------|
| ISO 10816-3 | Machine vibration Class II | RMS thresholds: Warning 2.8, Trip 4.5 mm/s |
| IEC 61508 | Functional safety (SIL-inspired) | Latching trips, dual-channel logic, audit trail |
| UN SDG 6.4 | Water-use efficiency | MPC rain-hold, per-zone accounting, ESG dashboard |
| ISA 5.1 | P&ID symbology | Vector schematic with standard tag prefixes |
| Modbus TCP | Industrial comms | Register map @ port 502 (simulated) |

> **Note**: HydroSync implements *inspired* safety patterns aligned with these
> standards for demonstration and competition purposes. It is not a certified
> SIL-rated safety system. The simulator and its evaluations do not establish
> real-pump performance.

---

## 🔧 Adding a New Agro-Hub

1. Add entry to `FLEET_FARMS` in `public/app.js`
2. Add coordinates to `LOCATION_COORDINATES` in `server.js`
3. Define crop profile in `CROP_PROFILES` (`public/app.js`)

---

## 🤝 Contributing

1. Fork → feature branch → PR
2. Maintain industrial code style: explicit types, defensive checks, audit logs
3. Update `README.md` for new capabilities
4. All safety-critical changes require double-review
5. Never commit `.env` or model artifacts (both are gitignored)

---

## 👥 Contributors & Team Responsibilities

HydroSync was developed by a cross-functional team. The table below lists each team member, their exact role, and their area of responsibility, aligned with the project evaluation criteria.

| Team Member | Exact Role | Responsibilities |
|-------------|------------|------------------|
| **Benseffa Ali Nasreddine** | Project Leader & Lead SCADA / Systems Architect | Core server architecture (`server.js`), safety interlocks (`core_control/mpc_controller.js`), physics simulation (`simulator.js`), security protocols (timing-safe auth, CSP, CORS, rate-limiting), and Git/GitHub synchronization |
| **Allali Syrine** | AI & ML Specialist | AI inference engine (`ai_engine/main.py`), ML predictor models (`ai_engine/ml_predictor.py`), and data pipelines (Task 1 HistGradientBoosting, Task 2/3 classifiers) |
| **Samy Ahmed Kayouche** | UX Designer & Frontend Developer | Dashboard UI/UX (`public/app.js`, `public/index.html`, `public/style.css`, `public/charts.js`), user experience evaluation, and client-side visualization (Chart.js, Leaflet.js GIS Fleet Map) |

### Responsibility Matrix by Domain

| Responsibility Area | Owner | Deliverables |
|---------------------|-------|--------------|
| **SCADA Architecture** | Benseffa Ali Nasreddine | `server.js` — Express + Socket.IO server, security headers/CSP/CORS, timing-safe auth, rate-limiting firewall, WebSocket session management, AI/Co-Pilot/Test Lab bridges, MPC gateway, graceful shutdown, CSV audit export |
| **Physics Simulation** | Benseffa Ali Nasreddine | `simulator.js` — pump/field physics, PID closed-loop control, DSP time-series vibration synthesizer (ISO 10816 harmonics), predictive maintenance model (bearing wear, cavitation, RUL), ESG/SDG 6.4 water accounting, safety interlock enforcement at physics layer, multi-zone micro-plots |
| **AI Inference Engine** | Allali Syrine | `ai_engine/main.py` — FastAPI service, SciPy/NumPy FFT vibration analysis, `/predict` endpoint (Task 1 HistGradientBoosting, Task 2/3 Random Forest classifiers), `/vibration`, `/diagnostics`, ML feature extraction, `ml_predictor.py` model loading and inference |
| **Database Schema** | Benseffa Ali Nasreddine | `database/schema.sql` — TimescaleDB (PostgreSQL 17) schema, experiments/telemetry hypertables, per-axis vibration telemetry, fault events, indexes, summary views, continuous aggregates; `database/db.js`, `telemetryCollector.js`, `demoMode.js`, `vibrationAnalysis.js`, `autoCollector.js` |
| **Frontend UI/UX** | Sami Ahmed Kayouche | `public/app.js` (IIFE architecture), `public/index.html`, `public/style.css`, `public/charts.js` — Chart.js v4.4.1 telemetry/DSP/horizon charts, Leaflet.js GIS Fleet Map, FontAwesome, Google Fonts, ISA 5.1 P&ID schematic, Modbus TCP register table, Web Serial USB edge, Operator authorization modal, AI Co-Pilot chat, AI Test Lab client |
| **Security & Interlocks** | Benseffa Ali Nasreddine | `core_control/mpc_controller.js` — `evaluateSafety`, `calculateIrrigationDuty`, `resetSafetyState`; dry-run, thermal overload, vibration trips (latching, PIN-reset); master operator PIN `1962` via `crypto.timingSafeEqual` |
| **DevOps & Deployment** | Benseffa Ali Nasreddine | `compose.yml` — TimescaleDB container; `package.json`, `.env` configuration; Render cloud deployment readiness; local run instructions (Node + Python + Docker) |

### Evaluation Criteria Mapping

| Criterion | Primary Owner | Supporting Files |
|-----------|---------------|------------------|
| SCADA architecture & real-time telemetry | Benseffa Ali Nasreddine | `server.js`, `simulator.js` |
| Physics simulation & pump/field model | Benseffa Ali Nasreddine | `simulator.js`, `core_control/mpc_controller.js` |
| AI inference & vibration diagnostics | Allali Syrine | `ai_engine/main.py`, `ai_engine/ml_predictor.py`, `ai_engine/ml_models/` |
| Database schema & telemetry persistence | Benseffa Ali Nasreddine | `database/schema.sql`, `database/telemetryCollector.js`, `database/db.js` |
| Frontend UI/UX & dashboard | Sami Ahmed Kayouche | `public/app.js`, `public/index.html`, `public/style.css`, `public/charts.js` |
| Safety interlocks & authorization | Benseffa Ali Nasreddine | `core_control/mpc_controller.js`, `server.js` (auth middleware) |

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
- **Google Gemini** — AI Co-Pilot integration

---

**HydroSync** — *Where cyber meets physical, and every drop counts.*
