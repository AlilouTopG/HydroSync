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

--

HydroSync is a simulated SCADA and digital-twin system for precision irrigation.
It combines a Node.js dashboard and control server, a pump-and-field simulator,
TimescaleDB telemetry storage, and a Python AI service.


## ◇ What the system does

- **Monitor:** streams simulator telemetry to a web dashboard over Socket.IO.
- **Control:** runs PID irrigation control, supports manual operation, and
  applies safety interlocks.
- **Simulate:** models pump operation, vibration, temperature, tank level,
  irrigation conditions, and equipment faults.
- **Analyze:** extracts vibration features and calls the AI service for
  diagnostics and three classification outputs.
- **Persist:** stores telemetry and experiment metadata in TimescaleDB.
- **Evaluate:** runs tagged Demo Mode scenarios and scores only measurement
  rows belonging to a selected run.

The project is a development/demo system. Its safety logic is
IEC 61508-inspired and is **not certified for safety-critical deployment**.
The simulator and its evaluations do not establish real-pump performance.

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




| Area | Main files | Responsibility |
|---|---|---|
| Dashboard and API | `public/`, `server.js` | Operator UI, telemetry, REST and Socket.IO |
| Digital twin | `simulator.js`, `database/demoMode.js` | Pump/field behavior and tagged demo scenarios |
| Storage and collection | `database/`, `export_multiaxis_dataset.js` | Telemetry persistence, experiment metadata, CSV export |
| AI inference | `ai_engine/main.py`, `ai_engine/ml_predictor.py` | Vibration analysis and Task 1/2/3 predictions |
| Task 1 data preparation | `rebuild_task1_dataset.js` | Recomputes Task 1 vibration features from source waveforms |
| Quick evaluation | `ml/evaluate_quick_demo.py` | Run-isolated evaluation of the active Task 1 HGB model |
| Full-run evaluation | `ml/evaluate_demo_models.py` | Run-isolated evaluation of all three active task heads |

## ◇ Project Structure

Key source, configuration, model, and test files are shown below. Local
environments, installed dependencies, generated reports, and large CSV datasets
are omitted.

```text
HydroSync/
├── server.js                         # Express and Socket.IO SCADA server
├── simulator.js                      # Pump, field, and vibration simulator
├── package.json                      # Node scripts and dependencies
├── compose.yml                       # Local TimescaleDB service
├── core_control/
│   └── mpc_controller.js             # Irrigation control and safety logic
├── database/
│   ├── schema.sql                    # TimescaleDB schema
│   ├── db.js                         # PostgreSQL connection pool
│   ├── telemetryCollector.js         # Experiment and telemetry persistence
│   ├── autoCollector.js              # Dataset collection workflows
│   ├── demoMode.js                   # Full and quick simulator sweeps
│   ├── conditionSetup.js             # Scenario initialization
│   └── vibrationAnalysis.js          # Shared six-feature waveform extraction
├── ai_engine/
│   ├── main.py                       # FastAPI AI service
│   ├── ml_predictor.py               # Active Task 1/2/3 inference
│   ├── requirements.txt              # Python runtime dependencies
│   ├── ml_models/
│   │   ├── hydrosync_task1_model.joblib # Active Task 1 HGB model
│   │   ├── hydrosync_task1_config.json # Task 1 features and threshold
│   │   ├── task2_rf_model.pkl          # Active Task 2 model
│   │   ├── task2_label_encoder.pkl
│   │   ├── task3_rf_model.pkl          # Active Task 3 model
│   │   └── task3_label_encoder.pkl
│   ├── tests/
│   │   └── test_ml_predictor.py
│   └── README.md                     # AI service-specific documentation
├── ml/
│   ├── evaluate_quick_demo.py        # Run-isolated simulator evaluation
│   ├── test_quick_demo_evaluation.py
│   ├── evaluate_demo_models.py       # Run-isolated Task 1/2/3 evaluation
│   └── inference.py                  # Legacy inference path
├── scripts/
│   └── download_models.ps1           # Checksum-verifies active model archive
├── public/
│   ├── index.html                    # SCADA dashboard
│   ├── app.js                        # UI and telemetry client
│   ├── charts.js                     # Telemetry and vibration charts
│   ├── style.css                     # Dashboard styles
│   └── images/
├── tests/
│   └── demoMode.test.js
├── export_multiaxis_dataset.js       # Telemetry-to-CSV export
├── rebuild_task1_dataset.js          # Task 1 waveform dataset rebuild
└── README.md                         # Project overview and local setup
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


## 🔧 Operator Workflow

1. **Observe** — Dashboard loads in `OBSERVER` mode (read-only telemetry)
2. **Authorize** — Click 🔒 lock icon → enter operator PIN → `OPERATOR` mode
3. **Control** — Adjust PID gains, setpoints, manual PWM override
4. **Disturb** — Inject drought/rain/emergency to test closed-loop recovery
5. **Reset** — On safety trip: click 🔒 → enter PIN → `Operator Reset` clears latch
6. **Export** — `Analytics` view → `Export Industrial Audit (CSV)`

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

The Node.js routes use `http://localhost:3000`; the Python AI routes use
`http://localhost:8000`.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/ai/diagnostics` | AI engine diagnostics and latest vibration features, including the source waveform's `sampleId` and capture-time `observedAt`; falls back to local status if the engine is offline |
| `GET` | `/api/ai/vibration` | Latest waveform, FFT, and features |
| `GET` | `/api/ai/vibration/multi-axis` | Latest multi-axis vibration data, FFT, and features |
| `GET` | `/api/export-audit.csv` | Download the current in-memory SCADA audit history as CSV |
| `POST` | `/api/chat` | Send a message to the AI co-pilot; requires `GEMINI_API_KEY`. Accepts an optional `sessionId` returned by the previous reply; set `newConversation: true` to start a separate conversation. |
| `POST` | `/api/demo/start` | Start the full Demo Mode sweep |
| `POST` | `/api/demo/quick/start` | Start the preliminary quick Demo Mode sweep |
| `POST` | `/api/demo/stop` | Stop the active Demo Mode sweep |
| `GET` | `/api/demo/status` | Read Demo Mode run status and progress |
| `GET` | `/` (port `3000`) | Serve the web dashboard |
| `GET` | `/` (port `8000`) | Python AI service health check |
| `GET` | `/diagnostics` (port `8000`) | Python AI service diagnostics |
| `POST` | `/api/predict_anomaly` (port `8000`) | Evaluate basic vibration, temperature, and flow thresholds |
| `POST` | `/vibration` (port `8000`) | Analyze submitted waveform data and update latest vibration results |
| `GET` | `/vibration/latest` (port `8000`) | Return the latest waveform analysis |
| `POST` | `/predict` (port `8000`) | Run Task 1, Task 2, and Task 3 classification |

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




## ◇ Database and Docker

HydroSync uses **TimescaleDB (PostgreSQL 17)** for persistent telemetry:

- `experiments` records collection runs and their metadata.
- `telemetry` stores timestamped pump state, vibration measurements and
  waveforms, ground-truth labels, model outputs, and flexible JSON metadata.
  It is a TimescaleDB hypertable partitioned by time.
- `telemetry_vibration_axes` stores synchronized per-axis waveform records;
  it is also a time-partitioned hypertable.
- `fault_events`, indexes, and summary views support event history and
  telemetry queries.

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

## ◇ Current AI integration

### AI Co-Pilot conversation context and prediction freshness

The dashboard Co-Pilot keeps up to 12 recent user/reply turns per conversation
in Node.js memory. Conversations use separate opaque session IDs, expire after
30 minutes of inactivity, and are bounded to 1,000 live sessions. Starting a
new conversation clears the browser's session ID and begins a new history.
Memory is process-local and is lost when the server restarts; it is used only to
resolve references in follow-up questions. Current telemetry, diagnostics, and
ML questions continue to use the live read-only tools, and history never changes
safety state or grants equipment permissions.

The prediction store records Node receipt time separately from any model
timestamp. Predictions are labeled fresh for up to 5 seconds (five cycles of
the existing one-second polling loop), then stale while remaining available for
traceability. The dashboard and agent read the same store; the agent validates
required class/confidence fields and freshness metadata before using a result.
Missing or invalid results are reported as unavailable, without inferring an ML
prediction from telemetry.

The Python service exposes `/predict`. It returns:

- **Task 1:** top-level state: `healthy`, `fault`, or `operating_condition`.
  The active model is a HistGradientBoosting classifier loaded from
  `ai_engine/ml_models/hydrosync_task1_model.joblib`; its configuration is
  `hydrosync_task1_config.json`. A configured healthy-probability threshold
  of `0.38` is used.
- **Task 2:** fault subtype prediction.
- **Task 3:** operating-condition prediction.

All three heads currently receive the same nine ordered inputs:
`vibration_rms`, `dominant_frequency_hz`, `one_x_amplitude`,
`two_x_amplitude`, `two_x_to_one_x_ratio`, `spectral_energy`,
`motor_temp_c`, `pwm_actual`, `pwm_target`.
Task 1 receives these values as a named pandas DataFrame matching its fitted
feature order; Task 2 and Task 3 retain their existing NumPy inputs.

Task 2 and Task 3 outputs are produced independently; Task 1 is the top-level
state. See the [AI Engine README](ai_engine/README.md) for inference details
and evaluation limitations.

## ◇ Evaluation snapshot

Full-sweep simulator run `dc48648b-53e8-4ed4-9362-36cf771d5929` scored 1,337 valid
measurement rows with the active predictor:

| Head | Rows | Accuracy | Balanced accuracy | Macro-F1 |
|---|---:|---:|---:|---:|
| Task 1 | 1,337 | 0.8534 | 0.8068 | 0.8049 |
| Task 2 | 743 | 0.8587 | 0.8579 | 0.8667 |
| Task 3 | 445 | 1.0000 | 1.0000 | 1.0000 |

Task 1’s main observed weakness was operating-condition recall (0.4933):
149 of 298 such rows were predicted as faults. Fault recall was 0.9539 and
healthy recall was 0.9732. In Task 2, motor-overheat precision was 0.5866.
Task 3 classified all evaluated rows correctly in this run.

These are repeated simulator telemetry rows, **not independent experiments**.
Stored predictions were available for 1,317 rows and all matched active
inference; 20 rows had no stored prediction. This is an integration consistency
check, not evidence of generalization. Do not use this run to tune thresholds
or alter ground-truth labels. The quick report and row predictions are generated
locally under `ml/reports/`.

## ◇ Run locally (Windows PowerShell)

Prerequisites: Node.js 18+, Python 3.10+, npm, and Docker Desktop with Docker
Compose. The commands below start the dashboard, AI engine, and database as
three local services.

### 1. Clone the repository

Replace the URL if you are cloning from a fork:

```powershell
git clone https://github.com/AlilouTopG/HydroSync.git
Set-Location .\HydroSync
```

### 2. Install Node dependencies

Run from the repository root:

```powershell
npm install
```

### Model artifacts (required before starting the AI engine)

The model files are too large and separately versioned, so they are not stored
in Git. Download the checksum-verified v1 archive and install its six active
artifacts before starting the Python service:

```powershell
.\scripts\download_models.ps1
```

The script downloads the published `hydrosync-ml-artifacts-v1.zip` asset from the HydroSync GitHub release tagged `ml-artifacts-v1`. It verifies the pinned SHA-256 and exact six-file contents before installing the artifacts. To use another approved host, pass its archive URL with `-ArchiveUrl`; the SHA-256 remains pinned and verified.

### 3. Start the database container

Compose currently defines **one Docker service only**: TimescaleDB
(`timescaledb`). It publishes PostgreSQL on host port `5433`, which matches
the application's local database default. On a first-time setup, apply the
schema once after the database is ready. Skip the schema command if your
database already has the HydroSync tables and views:

```powershell
docker compose up -d timescaledb
docker compose ps
do {
  Start-Sleep -Seconds 2
  docker exec hydrosync-timescaledb pg_isready -U hydrosync -d hydrosync
} until ($LASTEXITCODE -eq 0)
Get-Content .\database\schema.sql -Raw | docker exec -i hydrosync-timescaledb psql -U hydrosync -d hydrosync
```

`database/schema.sql` creates the extension, tables, hypertables, indexes,
views, and a continuous aggregate. Apply it to a fresh database only; it
includes a materialized view that is not declared with `IF NOT EXISTS`, so do
not blindly rerun it against an already initialized database.

To stop the container while preserving its data volume:

```powershell
docker compose down
```

### 4. Install Python AI dependencies

Open a second PowerShell window at the repository root:

```powershell
Set-Location .\ai_engine
py -3.12 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
```

Python **3.10 or newer** is required; replace `3.12` in the venv command if
using another installed supported version.

`uv` is optional. You do not need it to run the application. The venv and pip
commands above work with standard Python. If you prefer `uv`, install the same
manifest into a venv and run the service with that environment's interpreter:

```powershell
uv venv .venv
uv pip install --python .\.venv\Scripts\python.exe -r requirements.txt
uv run --python .\.venv\Scripts\python.exe main.py
```

### 5. Start the Python AI engine

In the same `ai_engine` PowerShell window, with `.venv` activated:

```powershell
python main.py
```

The AI API listens on `http://localhost:8000` by default. Keep this process
running.

### 6. Start the Node.js SCADA server

Open a third PowerShell window at the repository root:

```powershell
npm start
```

`npm start` runs `node server.js`; running `node .\server.js` from the
repository root is equivalent. `npm start` is the recommended command because
it uses the project's package script. The dashboard is at
`http://localhost:3000`.

The application reads optional local settings from `.env`, including `PORT`,
`AI_ENGINE_URL`, `CHAT_TIMEOUT_MS` (the chat request deadline in milliseconds;
defaults to `75000`), and database connection variables. With the Compose
service running and no overrides, the local database uses host `localhost`,
port `5433`, database `hydrosync`, and the development credentials in
`compose.yml`. These defaults are for local development only.

## ◇ Demo evaluation

The optional quick Demo Mode covers nine scenarios at PWM 40, 60, and 80;
each block uses a 30-second warm-up and 15-second measurement. Start it at
`POST /api/demo/quick/start`, monitor `GET /api/demo/status`, then evaluate
only that run:

```powershell
& .\ai_engine\.venv\Scripts\python.exe .\ml\evaluate_quick_demo.py --run-id <run-id>
```

The evaluator uses the active Task 1 artifact and fixed configuration, checks
run isolation, and reports metrics by class, scenario, and PWM. A quick
simulator evaluation is preliminary and is not a substitute for independent,
source/experiment-grouped validation or new measurements.

For a completed full Demo Mode run, the all-task evaluator recomputes Task 1,
Task 2, and Task 3 predictions with the active predictor and reports each
available task separately. It requires an explicit run ID and uses only
measurement rows from that run:

```powershell
& .\ai_engine\.venv\Scripts\python.exe .\ml\evaluate_demo_models.py --list-runs
& .\ai_engine\.venv\Scripts\python.exe .\ml\evaluate_demo_models.py --run-id <run-id>
```

Stored predictions are included only as an integration comparison; they are
not used as the primary evaluation predictions.

## ◇ Project status and boundaries

- The Task 1 HGB model is integrated in the active Python inference path.
- Task 2 and Task 3 models and outputs remain separately available.
- Task 1 source-waveform feature rebuilding and quick run-isolated evaluation
  tooling are present.
- The latest documented quick evaluation indicates a material
  operating-condition classification weakness; further model changes require
  representative, provenance-traceable data and independent validation.
- Do not overwrite `balanced_final.csv` or change Task 2/3 data and artifacts
  as part of Task 1 work.




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
### Adding a New Agro-Hub
1. Add entry to `FLEET_FARMS` in `public/app.js`
2. Add coordinates to `LOCATION_COORDINATES` in `server.js`
3. Define crop profile in `CROP_PROFILES` (`public/app.js`)

## 🤝 Contributing

1. Fork → feature branch → PR
2. Maintain industrial code style: explicit types, defensive checks, audit logs
3. Update `README.md` for new capabilities
4. All safety-critical changes require double-review

## 📄 License

MIT License — see `LICENSE` for details.

## 🙏 Acknowledgments

- **Open-Meteo** — Free satellite weather API
- **Leaflet + OpenStreetMap/CartoDB** — GIS mapping
- **Chart.js** — Real-time telemetry visualization
- **Socket.IO** — Low-latency WebSocket transport
- **FastAPI + SciPy/NumPy** — Edge AI vibration diagnostics

---

**HydroSync** — *Where cyber meets physical, and every drop counts.*
