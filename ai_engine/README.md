# HydroSync AI Engine

> **Why this is the second README:** this file is the focused guide for the
> Python AI service—its inference API, model responsibilities, feature contract,
> and evaluation limits. The [root README](../README.md) is the project-wide
> overview for the dashboard, simulator, storage, setup, and overall status.
>
> **System memory note:** The HydroSync Co‑Pilot chat retains conversational session memory (up to ~12 recent turns) for follow‑up queries. The AI Test Lab runs are isolated, finite‑state executions with no persistent memory across runs.
>
> See the root README for a detailed explanation of the memory model and operator workflow.

## ◇ Role in HydroSync

The Node.js server sends vibration and operating measurements to this FastAPI
service. The active predictor returns three independent classification heads:

| Head | Output | Active model |
|---|---|---|
| Task 1 | `healthy`, `fault`, `operating_condition` | HistGradientBoosting model |
| Task 2 | Equipment fault subtype | Existing classifier and label encoder |
| Task 3 | Operating-condition subtype | Existing classifier and label encoder |

Task 1 is the top-level state. Task 2 and Task 3 are still emitted independently
for evaluation and downstream use; a Task 1 result does not suppress them.

## ◇ Inference contract

`POST /predict` accepts these nine numeric fields in the configured Task 1
feature order:

```text
vibration_rms
dominant_frequency_hz
one_x_amplitude
two_x_amplitude
two_x_to_one_x_ratio
spectral_energy
motor_temp_c
pwm_actual
pwm_target
```

Task 1 reads its feature order and healthy threshold from
`ml_models/hydrosync_task1_config.json` and loads
`ml_models/hydrosync_task1_model.joblib`. The current threshold is `0.38`:
predict `healthy` when its probability meets the threshold; otherwise select
the higher-probability class between `fault` and `operating_condition`.
Inference sends Task 1 a pandas DataFrame with the configured names and order.
Task 2 and Task 3 retain their existing NumPy input path and artifacts.

## ◇ Model artifact setup

The active predictor needs six files under `ai_engine/ml_models`: the Task 1
HGB model and configuration, plus the Task 2 model/label encoder and Task 3
model/label encoder. These binaries are excluded from Git and distributed in
the versioned `hydrosync-ml-artifacts-v1.zip` archive. From the repository
root, install them with the SHA-256-verifying PowerShell script:

```powershell
.\scripts\download_models.ps1
```

The script downloads the published HydroSync GitHub release asset tagged `ml-artifacts-v1`. It verifies the pinned archive SHA-256 and exact six-file contents before installation. An approved alternate host can be used with `-ArchiveUrl`; the expected archive checksum is pinned in the script. The archive excludes datasets, generated reports, caches, and legacy Task 1 artifacts.

The response includes `state` and `state_confidence` for Task 1,
`fault_type` and `fault_confidence` for Task 2, and `operating_condition` and
`oc_confidence` for Task 3.

## ◇ Current evaluation snapshot

Full-sweep simulator run `dc48648b-53e8-4ed4-9362-36cf771d5929`:

| Head | Scored rows | Accuracy | Balanced accuracy | Macro-F1 |
|---|---:|---:|---:|---:|
| Task 1 | 1,337 | 0.8534 | 0.8068 | 0.8049 |
| Task 2 | 743 | 0.8587 | 0.8579 | 0.8667 |
| Task 3 | 445 | 1.0000 | 1.0000 | 1.0000 |

**Strengths in this run:** Task 1 fault recall was 0.9539 and healthy recall
was 0.9732. Task 3 classified all evaluated rows correctly.

**Weaknesses in this run:** Task 1 operating-condition recall was 0.4933;
149 of 298 operating-condition rows were predicted as faults. Task 2
motor-overheat precision was 0.5866, with other fault scenarios sometimes
predicted as motor overheat.

The 1,337 Task 1 measurements are repeated simulator rows, not independent
experiments. Stored predictions were available for 1,317 rows; all available
predictions matched the active predictor, while 20 were missing. This checks
integration consistency, not model generalization. The perfect Task 3 result
applies only to this simulator run. These metrics are not a real-world
performance claim and must not be used to tune thresholds or change labels.

The run-isolated quick evaluator is at
[`../ml/evaluate_quick_demo.py`](../ml/evaluate_quick_demo.py). The all-task
run evaluator is
[`../ml/evaluate_demo_models.py`](../ml/evaluate_demo_models.py); it recomputes
Task 1/2/3 predictions from the active predictor for one explicit run ID.
Neither evaluator uses stored predictions as its primary model output. See
the [root README](../README.md#evaluation-snapshot) for project-wide context
and run instructions.

## ◇ Local development

The AI engine runs as a local Python process; it is **not** a Docker service in
the current Compose file. The only Compose service is TimescaleDB. Start that
database from the repository root with `docker compose up -d timescaledb` as
described in the [root local setup guide](../README.md#run-locally-windows-powershell).

Python 3.10+ is required. From the `ai_engine/` directory, the standard
Python venv and pip workflow is:

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
python main.py
```

Change `3.12` if using a different installed Python version that is 3.10 or
newer. `uv` is optional; it is not required by the project. To use it instead:

```powershell
uv venv .venv
uv pip install --python .\.venv\Scripts\python.exe -r requirements.txt
uv run --python .\.venv\Scripts\python.exe main.py
```

The complete runtime dependency list, including pandas and joblib used by the
active predictor, is in `requirements.txt`. The service loads model files from
`ai_engine/ml_models` at startup and listens on port `8000` by default. The Node
server calls it at `http://localhost:8000` unless `AI_ENGINE_URL` is configured
otherwise.

The engine is part of a simulator/demo project. Model quality, safety, and
generalization must be validated independently before any operational use.
