"""Run-scoped evaluation of HydroSync demo telemetry.

Primary Task 1 metrics are recomputed with the active predictor in
ai_engine/ml_predictor.py, rather than trusting stored ml_state values.
Task 2 and Task 3 metrics use the corresponding heads returned by that same
active MLPredictor instance. The query maps the physical telemetry schema to
the nine configured model features (pump_duty_pct -> pwm_actual; collection
metadata -> pwm_target).

Run from the ai_engine environment, for example:
  uv run python ..\\ml\\evaluate_demo_models.py --list-runs
  uv run python ..\\ml\\evaluate_demo_models.py --run-id <FULL_SWEEP_RUN_UUID>

The script deliberately fails closed if it cannot isolate the requested run.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from io import StringIO
from pathlib import Path
from typing import Any
from uuid import UUID

import pandas as pd
from sklearn.metrics import (
    accuracy_score,
    balanced_accuracy_score,
    classification_report,
    confusion_matrix,
    f1_score,
)

ROOT = Path(__file__).resolve().parents[1]
AI_ENGINE_DIR = ROOT / "ai_engine"
REPORT_DIR = ROOT / "ml" / "reports"

FEATURES = [
    "vibration_rms",
    "dominant_frequency_hz",
    "one_x_amplitude",
    "two_x_amplitude",
    "two_x_to_one_x_ratio",
    "spectral_energy",
    "motor_temp_c",
    "pwm_actual",
    "pwm_target",
]

# The nine model features are not nine physical columns in telemetry.
# Vibration values exist as ordinary columns (with the JSONB `features`
# object as a fallback); actual PWM is stored as pump_duty_pct; and target
# PWM is stored in collection metadata. Alias them to the model's feature
# names here so the model receives the same schema used during training.
FEATURE_SQL = {
    "vibration_rms": "COALESCE(vibration_rms, NULLIF(features->>'vibration_rms', '')::double precision)",
    "dominant_frequency_hz": "COALESCE(dominant_frequency_hz, NULLIF(features->>'dominant_frequency_hz', '')::double precision)",
    "one_x_amplitude": "COALESCE(one_x_amplitude, NULLIF(features->>'one_x_amplitude', '')::double precision)",
    "two_x_amplitude": "COALESCE(two_x_amplitude, NULLIF(features->>'two_x_amplitude', '')::double precision)",
    "two_x_to_one_x_ratio": "COALESCE(two_x_to_one_x_ratio, NULLIF(features->>'two_x_to_one_x_ratio', '')::double precision)",
    "spectral_energy": "COALESCE(spectral_energy, NULLIF(features->>'spectral_energy', '')::double precision)",
    "motor_temp_c": "motor_temp_c",
    "pwm_actual": "COALESCE(pump_duty_pct, NULLIF(model_metadata->'collection'->>'demo_pwm', '')::double precision)",
    "pwm_target": "COALESCE(NULLIF(model_metadata->'collection'->>'pwm_target', '')::double precision, NULLIF(model_metadata->'collection'->>'demo_pwm', '')::double precision, pump_duty_pct)",
}

TASK1_LABELS = ["fault", "healthy", "operating_condition"]
TASK2_LABELS = [
    "rotor_imbalance",
    "bearing_wear",
    "bearing_fault",
    "cavitation",
    "motor_overheat",
]
TASK3_LABELS = ["dry_run", "drought", "flood_risk"]

FAULT_SCENARIOS = set(TASK2_LABELS) | {"dry_run"}
TASK1_OC_SCENARIOS = {"drought", "flood_risk"}
ALL_SCENARIOS = {"healthy"} | FAULT_SCENARIOS | TASK1_OC_SCENARIOS
TASK3_SCENARIOS = set(TASK3_LABELS)

# Support either nested collection metadata or top-level run metadata. The
# demo-mode and measurement-phase filters are still mandatory in every query.
RUN_ID_EXPR = (
    "COALESCE(\n"
    "  model_metadata->'collection'->>'demo_run_id',\n"
    "  model_metadata->>'demo_run_id',\n"
    "  model_metadata->'collection'->>'run_id',\n"
    "  model_metadata->>'run_id'\n"
    ")"
)

BASE_FILTER = """
model_metadata->'collection'->>'demo_mode' = 'true'
AND model_metadata->'collection'->>'demo_phase' = 'measurement'
"""


def psql_copy(sql: str) -> pd.DataFrame:
    """Execute COPY (...) TO STDOUT with the project's local TimescaleDB."""
    cmd = [
        "docker",
        "exec",
        "-i",
        "hydrosync-timescaledb",
        "psql",
        "-X",
        "-v",
        "ON_ERROR_STOP=1",
        "-U",
        "hydrosync",
        "-d",
        "hydrosync",
        "-c",
        sql,
    ]
    try:
        result = subprocess.run(
            cmd,
            check=True,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
    except FileNotFoundError as exc:
        raise RuntimeError(
            "Could not find `docker`. Run this script on the HydroSync machine "
            "where Docker Desktop and the hydrosync-timescaledb container are available."
        ) from exc
    except subprocess.CalledProcessError as exc:
        details = (exc.stderr or exc.stdout or str(exc)).strip()
        raise RuntimeError(f"psql query failed:\n{details}") from exc

    if not result.stdout.strip():
        return pd.DataFrame()
    try:
        return pd.read_csv(StringIO(result.stdout))
    except Exception as exc:
        preview = result.stdout[:1500]
        raise RuntimeError(
            f"Could not parse psql CSV output. Output begins:\n{preview}"
        ) from exc


def list_runs() -> None:
    sql = f"""
COPY (
  SELECT
    {RUN_ID_EXPR} AS demo_run_id,
    COUNT(*) AS measurement_rows,
    COUNT(DISTINCT model_metadata->'collection'->>'demo_state') AS scenario_count,
    STRING_AGG(
      DISTINCT model_metadata->'collection'->>'demo_state', ', '
      ORDER BY model_metadata->'collection'->>'demo_state'
    ) AS scenarios
  FROM telemetry
  WHERE {BASE_FILTER}
  GROUP BY {RUN_ID_EXPR}
  ORDER BY COUNT(*) DESC
) TO STDOUT WITH CSV HEADER;
"""
    runs = psql_copy(sql)
    if runs.empty:
        print("No demo measurement rows found in telemetry.")
        return
    print(
        "Available demo measurement groups (only use a row with the full sweep's run ID):"
    )
    print(runs.fillna("").to_string(index=False))
    if "demo_run_id" in runs and runs["demo_run_id"].isna().any():
        print(
            "\nWARNING: some rows have no persisted run ID. They cannot be safely "
            "assigned to a specific sweep; this evaluator will not score them."
        )


def task1_truth(state: str) -> str:
    """Ground-truth mapping used by the rebuilt Task 1 dataset."""
    if state == "healthy":
        return "healthy"
    if state in TASK1_OC_SCENARIOS:
        return "operating_condition"
    if state in FAULT_SCENARIOS:
        return "fault"
    raise ValueError(f"Unrecognized demo_state {state!r}; refusing to guess its label.")


def score(y_true: pd.Series, y_pred: pd.Series, labels: list[str]) -> dict[str, Any]:
    """Compute fixed-label metrics. Missing predictions remain errors, not dropped rows."""
    yt = y_true.astype(str)
    yp = y_pred.fillna("__missing_prediction__").astype(str)
    cm = confusion_matrix(yt, yp, labels=labels)
    report = classification_report(
        yt,
        yp,
        labels=labels,
        target_names=labels,
        zero_division=0,
        output_dict=True,
    )
    return {
        "rows_scored": int(len(yt)),
        "missing_predictions": int((yp == "__missing_prediction__").sum()),
        "accuracy": float(accuracy_score(yt, yp)),
        "balanced_accuracy": float(balanced_accuracy_score(yt, yp)),
        "macro_f1": float(
            f1_score(yt, yp, labels=labels, average="macro", zero_division=0)
        ),
        "weighted_f1": float(
            f1_score(yt, yp, labels=labels, average="weighted", zero_division=0)
        ),
        "labels": labels,
        "confusion_matrix": cm.tolist(),
        "classification_report": report,
    }


def print_score(title: str, result: dict[str, Any]) -> None:
    print(f"\n=== {title} ===")
    print("Rows scored:", result["rows_scored"])
    print("Missing predictions:", result["missing_predictions"])
    print(f"Accuracy:          {result['accuracy']:.4f}")
    print(f"Balanced accuracy: {result['balanced_accuracy']:.4f}")
    print(f"Macro F1:          {result['macro_f1']:.4f}")
    print(f"Weighted F1:       {result['weighted_f1']:.4f}")
    print("\nPer-class report:")
    print(pd.DataFrame(result["classification_report"]).T.round(4).to_string())
    print("\nConfusion matrix (rows=true, columns=predicted; label order shown below):")
    print("Labels:", result["labels"])
    print(
        pd.DataFrame(
            result["confusion_matrix"], index=result["labels"], columns=result["labels"]
        ).to_string()
    )


def run_evaluation(run_id: str) -> None:
    # UUID validation makes the run ID safe to interpolate into the SQL literal.
    run_id = str(UUID(run_id))
    sql = f"""
COPY (
  SELECT
    {RUN_ID_EXPR} AS demo_run_id,
    model_metadata->'collection'->>'demo_state' AS demo_state,
    model_metadata->'collection'->>'demo_pwm' AS demo_pwm,
    ml_state AS stored_ml_state,
    ml_fault_type AS stored_ml_fault_type,
    ml_operating_condition AS stored_ml_operating_condition,
    {", ".join(f"{FEATURE_SQL[name]} AS {name}" for name in FEATURES)}
  FROM telemetry
  WHERE {BASE_FILTER}
    AND {RUN_ID_EXPR} = '{run_id}'
  ORDER BY model_metadata->'collection'->>'demo_state',
           model_metadata->'collection'->>'demo_pwm'
) TO STDOUT WITH CSV HEADER;
"""
    df = psql_copy(sql)
    if df.empty:
        print(f"ERROR: no measurement rows found for run ID {run_id}.", file=sys.stderr)
        print(
            "No cross-run fallback will be used. Check that the ID belongs to the full sweep and is persisted in telemetry.\n",
            file=sys.stderr,
        )
        print("Known run IDs:", file=sys.stderr)
        list_runs()
        raise SystemExit(2)

    df["demo_state"] = df["demo_state"].astype("string").str.strip().str.lower()
    if df["demo_state"].isna().any() or (df["demo_state"] == "").any():
        raise RuntimeError(
            "Selected run contains rows without demo_state; refusing to score incomplete ground truth."
        )
    unknown_states = sorted(set(df["demo_state"].dropna().astype(str)) - ALL_SCENARIOS)
    if unknown_states:
        raise RuntimeError(
            f"Unknown demo_state values in selected run: {unknown_states}. Update/verify ground-truth mapping before scoring."
        )

    # Convert all model features explicitly; invalid rows are reported and excluded from model scoring.
    for col in FEATURES:
        df[col] = pd.to_numeric(df[col], errors="coerce")
    valid_feature_mask = df[FEATURES].notna().all(axis=1) & df[FEATURES].apply(
        lambda s: s.map(pd.notna)
    ).all(axis=1)
    invalid_feature_rows = int((~valid_feature_mask).sum())
    work = df.loc[valid_feature_mask].copy().reset_index(drop=True)
    if work.empty:
        raise RuntimeError(
            "No rows in the selected run have all nine valid Task 1 features."
        )

    # Import the same predictor class used by the running FastAPI service.
    sys.path.insert(0, str(AI_ENGINE_DIR))
    try:
        from ml_predictor import MLPredictor  # type: ignore
    except Exception as exc:
        raise RuntimeError(
            "Could not import ai_engine/ml_predictor.py. Run this script with the "
            "ai_engine uv environment (e.g. `uv run python ..\\ml\\evaluate_demo_models.py ...`)."
        ) from exc

    predictor = MLPredictor()
    active_features = list(getattr(predictor, "features", []))
    if active_features != FEATURES:
        raise RuntimeError(
            "Active predictor feature order does not match the telemetry schema.\n"
            f"Expected: {FEATURES}\nLoaded:   {active_features}\n"
            "Do not score until the feature/config mismatch is resolved."
        )

    predictions: list[dict[str, Any]] = []
    for _, row in work.iterrows():
        sample = {feature: float(row[feature]) for feature in FEATURES}
        try:
            output = predictor.predict(sample)
        except Exception as exc:
            raise RuntimeError(
                f"Active predictor failed on a telemetry row from run {run_id}: {exc}"
            ) from exc
        predictions.append(
            {
                "task1_pred": output.get("state"),
                "task1_confidence": output.get("state_confidence"),
                "task2_pred": output.get("fault_type"),
                "task2_confidence": output.get("fault_confidence"),
                "task3_pred": output.get("operating_condition"),
                "task3_confidence": output.get("oc_confidence"),
            }
        )

    pred_df = pd.DataFrame(predictions)
    for col in pred_df.columns:
        work[col] = pred_df[col]

    work["task1_true"] = work["demo_state"].astype(str).map(task1_truth)
    work["task2_true"] = work["demo_state"].where(work["demo_state"].isin(TASK2_LABELS))
    work["task3_true"] = work["demo_state"].where(work["demo_state"].isin(TASK3_LABELS))

    # Task 1 is the principal evaluation: fresh features -> active HGB predictor.
    task1_result = score(work["task1_true"], work["task1_pred"], TASK1_LABELS)
    print("\nHydroSync simulator evaluation")
    print("Run ID:", run_id)
    print("Predictor:", "active ai_engine/ml_predictor.py")
    print("Task 1 feature order:", active_features)
    print("Healthy threshold:", getattr(predictor, "healthy_threshold", "not exposed"))
    print("Measurement rows selected for this run:", int(len(df)))
    print("Valid feature rows scored:", int(len(work)))
    print("Rows excluded for invalid/missing features:", invalid_feature_rows)
    print(
        "Note: rows within a scenario/PWM block are repeated simulator telemetry, not independent experiments."
    )

    print_score(
        "TASK 1 — active model, recomputed from telemetry features", task1_result
    )

    # Task 2/3 are reported separately using their current heads from MLPredictor.
    task2_df = work.loc[work["task2_true"].notna()].copy()
    task2_result: dict[str, Any] | None = None
    if not task2_df.empty:
        task2_result = score(
            task2_df["task2_true"], task2_df["task2_pred"], TASK2_LABELS
        )
        print_score(
            "TASK 2 — fault subtype head (five fault scenarios only)", task2_result
        )
    else:
        print("\n=== TASK 2 ===\nNo Task 2 fault-scenario rows in this run.")

    task3_df = work.loc[work["task3_true"].notna()].copy()
    task3_result: dict[str, Any] | None = None
    if not task3_df.empty:
        task3_result = score(
            task3_df["task3_true"], task3_df["task3_pred"], TASK3_LABELS
        )
        print_score("TASK 3 — operating-condition head", task3_result)
    else:
        print("\n=== TASK 3 ===\nNo Task 3 operating-condition rows in this run.")

    # Check, but do not use, database-stored predictions as primary evaluation outputs.
    def live_comparison(stored_col: str, pred_col: str) -> dict[str, Any]:
        stored = work[stored_col].astype("string").str.strip().str.lower()
        recomputed = work[pred_col].astype("string").str.strip().str.lower()
        available = (
            stored.notna() & (stored != "") & recomputed.notna() & (recomputed != "")
        )
        return {
            "stored_prediction_rows_available": int(available.sum()),
            "stored_prediction_rows_missing": int(
                (~(stored.notna() & (stored != ""))).sum()
            ),
            "mismatches_vs_active_predictor": int(
                (stored[available] != recomputed[available]).sum()
            ),
        }

    live_check = {
        "task1": live_comparison("stored_ml_state", "task1_pred"),
        "task2": live_comparison("stored_ml_fault_type", "task2_pred"),
        "task3": live_comparison("stored_ml_operating_condition", "task3_pred"),
    }
    print("\n=== STORED LIVE-PREDICTION COMPARISON (integration check only) ===")
    print(json.dumps(live_check, indent=2))

    # Scenario and scenario/PWM accuracy for Task 1.
    per_scenario: dict[str, Any] = {}
    for scenario, group in work.groupby("demo_state", dropna=False):
        per_scenario[str(scenario)] = {
            "rows": int(len(group)),
            "expected_task1_class": str(group["task1_true"].iloc[0]),
            "accuracy": float((group["task1_true"] == group["task1_pred"]).mean()),
            "prediction_counts": {
                str(k): int(v)
                for k, v in group["task1_pred"]
                .fillna("__missing_prediction__")
                .value_counts()
                .items()
            },
        }
    per_scenario_pwm: dict[str, Any] = {}
    for (scenario, pwm), group in work.groupby(
        ["demo_state", "demo_pwm"], dropna=False
    ):
        key = f"{scenario}|PWM={pwm if pd.notna(pwm) else 'unknown'}"
        per_scenario_pwm[key] = {
            "rows": int(len(group)),
            "expected_task1_class": str(group["task1_true"].iloc[0]),
            "accuracy": float((group["task1_true"] == group["task1_pred"]).mean()),
        }

    # Save machine-readable report and row-level predictions for reproducibility.
    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    report_path = REPORT_DIR / f"demo_f1_{run_id}.json"
    predictions_path = REPORT_DIR / f"demo_predictions_{run_id}.csv"
    report: dict[str, Any] = {
        "evaluation": "run-scoped simulator evaluation; not evidence of real-pump generalization",
        "run_id": run_id,
        "predictor": "active ai_engine/ml_predictor.py",
        "feature_order": active_features,
        "healthy_threshold": getattr(predictor, "healthy_threshold", None),
        "measurement_rows_selected": int(len(df)),
        "valid_feature_rows_scored": int(len(work)),
        "invalid_feature_rows_excluded": invalid_feature_rows,
        "task1_truth_mapping": {
            "healthy": "healthy",
            "drought": "operating_condition",
            "flood_risk": "operating_condition",
            "rotor_imbalance": "fault",
            "bearing_wear": "fault",
            "bearing_fault": "fault",
            "cavitation": "fault",
            "motor_overheat": "fault",
            "dry_run": "fault",
        },
        "task1": task1_result,
        "task2": task2_result,
        "task3": task3_result,
        "stored_live_prediction_comparison": live_check,
        "task1_per_scenario": per_scenario,
        "task1_per_scenario_pwm": per_scenario_pwm,
        "limitations": [
            "Repeated telemetry rows from the same scenario/PWM block are correlated; row count is not the number of independent experiments.",
            "Task 1 primary metrics are recomputed from the active predictor and stored features; stored predictions are only an integration comparison.",
            "Simulator performance does not establish generalization to a physical pump.",
        ],
        "row_level_predictions_csv": str(predictions_path),
    }
    with report_path.open("w", encoding="utf-8") as f:
        json.dump(report, f, indent=2, ensure_ascii=False, default=str)

    keep_cols = [
        "demo_run_id",
        "demo_state",
        "demo_pwm",
        *FEATURES,
        "task1_true",
        "task1_pred",
        "task1_confidence",
        "task2_true",
        "task2_pred",
        "task2_confidence",
        "task3_true",
        "task3_pred",
        "task3_confidence",
        "stored_ml_state",
        "stored_ml_fault_type",
        "stored_ml_operating_condition",
    ]
    work[keep_cols].to_csv(predictions_path, index=False, encoding="utf-8")
    print("\nSaved JSON report:", report_path)
    print("Saved row-level predictions:", predictions_path)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Evaluate one HydroSync Demo Mode run."
    )
    parser.add_argument("--run-id", help="UUID of the completed full sweep to evaluate")
    parser.add_argument(
        "--list-runs",
        action="store_true",
        help="List persisted run IDs and demo measurement row counts",
    )
    args = parser.parse_args()

    if args.list_runs:
        list_runs()
        return
    if not args.run_id:
        parser.error("provide --run-id <FULL_SWEEP_UUID> or use --list-runs first")
    try:
        run_evaluation(args.run_id)
    except (RuntimeError, ValueError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise SystemExit(2) from exc


if __name__ == "__main__":
    main()
