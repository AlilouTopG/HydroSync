"""Evaluate one isolated quick Demo Mode run against the active Task 1 HGB model."""

import argparse
import csv
import json
import math
import subprocess
import sys
from collections import Counter
from io import StringIO
from pathlib import Path
from uuid import UUID

import joblib
import numpy as np
from sklearn.metrics import (
    accuracy_score,
    balanced_accuracy_score,
    confusion_matrix,
    f1_score,
    precision_recall_fscore_support,
)

ROOT_DIR = Path(__file__).resolve().parents[1]
MODEL_DIR = ROOT_DIR / "ai_engine" / "ml_models"
CONFIG_PATH = MODEL_DIR / "hydrosync_task1_config.json"
MODEL_PATH = MODEL_DIR / "hydrosync_task1_model.joblib"
SCENARIO_TO_LABEL = {
    "healthy": "healthy",
    "rotor_imbalance": "fault",
    "bearing_wear": "fault",
    "bearing_fault": "fault",
    "cavitation": "fault",
    "motor_overheat": "fault",
    "dry_run": "fault",
    "drought": "operating_condition",
    "flood_risk": "operating_condition",
}
PWM_LEVELS = (40, 60, 80)
CLASS_NAMES = ("fault", "healthy", "operating_condition")
MIN_VALID_ROWS_PER_BLOCK = 5
FEATURES_SQL = """
    vibration_rms, dominant_frequency_hz, one_x_amplitude,
    two_x_amplitude, two_x_to_one_x_ratio, spectral_energy,
    motor_temp_c, pump_duty_pct AS pwm_actual,
    NULLIF(model_metadata->'collection'->>'pwm_target', '')::double precision AS pwm_target
"""


def validate_run_id(run_id):
    try:
        parsed = UUID(run_id)
    except (AttributeError, TypeError, ValueError) as error:
        raise ValueError("run ID must be a UUID returned by /api/demo/quick/start") from error
    if str(parsed) != run_id.lower():
        raise ValueError("run ID must be a canonical UUID")
    return str(parsed)


def task1_truth(demo_state):
    try:
        return SCENARIO_TO_LABEL[demo_state]
    except KeyError as error:
        raise ValueError(f"Unknown quick Demo Mode scenario: {demo_state!r}") from error


def build_export_sql(run_id):
    run_id = validate_run_id(run_id)
    return f"""
COPY (
  SELECT
    model_metadata->'collection'->>'demo_run_id' AS demo_run_id,
    model_metadata->'collection'->>'demo_run_mode' AS demo_run_mode,
    model_metadata->'collection'->>'demo_state' AS demo_state,
    model_metadata->'collection'->>'demo_pwm' AS demo_pwm,
    model_metadata->'collection'->>'demo_phase' AS demo_phase,
    ml_state,
    {FEATURES_SQL}
  FROM telemetry
  WHERE model_metadata->'collection'->>'demo_mode' = 'true'
    AND model_metadata->'collection'->>'demo_run_id' = '{run_id}'
    AND model_metadata->'collection'->>'demo_run_mode' = 'quick'
    AND model_metadata->'collection'->>'demo_phase' = 'measurement'
) TO STDOUT WITH CSV HEADER;
"""


def parse_rows(raw_csv, requested_run_id):
    requested_run_id = validate_run_id(requested_run_id)
    rows = list(csv.DictReader(StringIO(raw_csv)))
    mismatched = [
        row.get("demo_run_id")
        for row in rows
        if row.get("demo_run_id") != requested_run_id
    ]
    if mismatched:
        raise ValueError(
            f"Database returned {len(mismatched)} rows outside requested run {requested_run_id}"
        )
    wrong_scope = [
        row for row in rows
        if row.get("demo_phase") != "measurement" or row.get("demo_run_mode") != "quick"
    ]
    if wrong_scope:
        raise ValueError("Database returned rows outside the requested quick measurement scope")
    return rows


def classify_probabilities(classes, probabilities, threshold):
    class_indices = {str(name): index for index, name in enumerate(classes)}
    if set(class_indices) != set(CLASS_NAMES):
        raise ValueError("Task 1 model classes must be fault, healthy, and operating_condition")
    healthy_index = class_indices["healthy"]
    fault_index = class_indices["fault"]
    operating_index = class_indices["operating_condition"]
    predicted_indices = []
    for probabilities_row in probabilities:
        if probabilities_row[healthy_index] >= threshold:
            predicted_indices.append(healthy_index)
        elif probabilities_row[fault_index] >= probabilities_row[operating_index]:
            predicted_indices.append(fault_index)
        else:
            predicted_indices.append(operating_index)
    return [str(classes[index]) for index in predicted_indices]


def score_group(rows, expected_label=None):
    if not rows:
        return {
            "rows": 0,
            "accuracy": None,
            "macro_f1": None,
            **({
                "precision": None,
                "recall": None,
                "f1": None
            } if expected_label else {})
        }
    truths = [expected_label or task1_truth(row["demo_state"]) for row in rows]
    predictions = [row["active_model_prediction"] for row in rows]
    labels = [expected_label] if expected_label else CLASS_NAMES
    precision, recall, f1, _support = precision_recall_fscore_support(
        truths, predictions, labels=labels, zero_division=0
    )
    result = {
        "rows": len(rows),
        "accuracy": float(accuracy_score(truths, predictions)),
        "macro_f1": float(sum(f1) / len(f1)),
    }
    if expected_label:
        result.update({
            "precision": float(precision[0]),
            "recall": float(recall[0]),
            "f1": float(f1[0])
        })
    return result


def compute_report(run_id, rows, model, config):
    run_id = validate_run_id(run_id)
    features = config.get("features")
    threshold = config.get("healthy_threshold")
    if not isinstance(features, list) or len(features) != 9 or len(set(features)) != 9:
        raise ValueError("Task 1 config must contain nine unique feature names")
    if threshold != 0.38:
        raise ValueError(f"Expected unchanged healthy threshold 0.38, got {threshold!r}")
    if list(model.classes_) != list(config.get("classes", [])):
        raise ValueError("Task 1 model classes do not match hydrosync_task1_config.json")
    if set(model.classes_) != set(CLASS_NAMES):
        raise ValueError("Task 1 model does not expose the expected three classes")
    if getattr(model, "n_features_in_", len(features)) != len(features):
        raise ValueError("Task 1 model feature count does not match its config")
    model_features = getattr(model, "feature_names_in_", None)
    if model_features is not None and [str(name) for name in model_features] != features:
        raise ValueError("Task 1 model feature order does not match its config")

    errors = []
    rows_by_block = {}
    valid_rows = []
    invalid_feature_rows = 0
    missing_live_predictions = 0
    live_prediction_mismatches = 0
    live_predictions_by_block = Counter()
    expected_blocks = {
        (scenario, pwm)
        for scenario in SCENARIO_TO_LABEL
        for pwm in PWM_LEVELS
    }

    for row in rows:
        scenario = row.get("demo_state", "")
        try:
            label = task1_truth(scenario)
            pwm_float = float(row.get("demo_pwm", ""))
            if not math.isfinite(pwm_float) or pwm_float not in PWM_LEVELS:
                raise ValueError(f"unexpected PWM block {row.get('demo_pwm')!r}")
            pwm = int(pwm_float)
        except (ValueError, TypeError) as error:
            errors.append(str(error))
            continue

        block = (scenario, pwm)
        rows_by_block.setdefault(block, []).append(row)
        values = []
        try:
            for feature in features:
                value = float(row.get(feature, ""))
                if not math.isfinite(value):
                    raise ValueError(feature)
                values.append(value)
        except (TypeError, ValueError):
            invalid_feature_rows += 1
            continue

        row["_feature_values"] = values
        row["_true_label"] = label
        valid_rows.append(row)
        if not row.get("ml_state"):
            missing_live_predictions += 1
        else:
            live_predictions_by_block[block] += 1

    seen_blocks = set(rows_by_block)
    missing_blocks = sorted(expected_blocks - seen_blocks)
    for scenario, pwm in missing_blocks:
        errors.append(f"missing scenario/PWM block: {scenario} at {pwm}")

    for block in sorted(expected_blocks):
        block_rows = [
            row for row in rows_by_block.get(block, [])
            if "_feature_values" in row
        ]
        if len(block_rows) < MIN_VALID_ROWS_PER_BLOCK:
            errors.append(
                f"{block[0]} at PWM {block[1]} has {len(block_rows)} valid feature rows; "
                f"requires at least {MIN_VALID_ROWS_PER_BLOCK}"
            )
        live_count = live_predictions_by_block.get(block, 0)
        if live_count < MIN_VALID_ROWS_PER_BLOCK:
            errors.append(
                f"{block[0]} at PWM {block[1]} has {live_count} stored live predictions; "
                f"requires at least {MIN_VALID_ROWS_PER_BLOCK}"
            )

    if valid_rows:
        matrix = np.asarray(
            [row["_feature_values"] for row in valid_rows],
            dtype=float
        )
        probabilities = model.predict_proba(matrix)
        active_predictions = classify_probabilities(
            model.classes_, probabilities, threshold
        )
        for row, prediction in zip(valid_rows, active_predictions):
            row["active_model_prediction"] = prediction
            if row.get("ml_state") and row["ml_state"] != prediction:
                live_prediction_mismatches += 1
    if live_prediction_mismatches:
        errors.append(
            f"{live_prediction_mismatches} stored live predictions differ from the "
            "active Task 1 artifact; confirm the AI engine was restarted with the current model"
        )

    truths = [row["_true_label"] for row in valid_rows]
    predictions = [row["active_model_prediction"] for row in valid_rows]
    per_class = {}
    if valid_rows:
        precision, recall, f1, support = precision_recall_fscore_support(
            truths, predictions, labels=CLASS_NAMES, zero_division=0
        )
        per_class = {
            name: {
                "precision": float(precision[index]),
                "recall": float(recall[index]),
                "f1": float(f1[index]),
                "support": int(support[index])
            }
            for index, name in enumerate(CLASS_NAMES)
        }

    scenario_results = {}
    sample_counts_by_scenario = {}
    for scenario, expected_label in SCENARIO_TO_LABEL.items():
        scenario_rows = [
            row for row in valid_rows if row["demo_state"] == scenario
        ]
        details = score_group(scenario_rows, expected_label)
        details["pwm_blocks"] = {
            str(pwm): {
                **score_group(
                    [
                        row for row in scenario_rows
                        if int(float(row["demo_pwm"])) == pwm
                    ],
                    expected_label
                ),
                "measurement_rows": len(rows_by_block.get((scenario, pwm), [])),
                "stored_live_prediction_rows": live_predictions_by_block.get(
                    (scenario, pwm), 0
                )
            }
            for pwm in PWM_LEVELS
        }
        details["measurement_rows"] = sum(
            len(rows_by_block.get((scenario, pwm), []))
            for pwm in PWM_LEVELS
        )
        sample_counts_by_scenario[scenario] = {
            str(pwm): {
                "measurement_rows": len(rows_by_block.get((scenario, pwm), [])),
                "valid_feature_rows": sum(
                    1 for row in scenario_rows
                    if int(float(row["demo_pwm"])) == pwm
                ),
                "stored_live_prediction_rows": live_predictions_by_block.get(
                    (scenario, pwm), 0
                )
            }
            for pwm in PWM_LEVELS
        }
        scenario_results[scenario] = details

    pwm_results = {
        str(pwm): {
            **score_group([
                row for row in valid_rows if int(float(row["demo_pwm"])) == pwm
            ]),
            "measurement_rows": sum(
                len(rows_by_block.get((scenario, pwm), []))
                for scenario in SCENARIO_TO_LABEL
            ),
            "stored_live_prediction_rows": sum(
                live_predictions_by_block.get((scenario, pwm), 0)
                for scenario in SCENARIO_TO_LABEL
            )
        }
        for pwm in PWM_LEVELS
    }

    if len(valid_rows) == 0:
        metrics = {
            "accuracy": None,
            "balanced_accuracy": None,
            "macro_f1": None,
            "per_class": {},
            "confusion_matrix": {"labels": list(CLASS_NAMES), "values": []}
        }
    else:
        metrics = {
            "accuracy": float(accuracy_score(truths, predictions)),
            "balanced_accuracy": float(balanced_accuracy_score(truths, predictions)),
            "macro_f1": float(f1_score(
                truths, predictions, labels=CLASS_NAMES,
                average="macro", zero_division=0
            )),
            "per_class": per_class,
            "confusion_matrix": {
                "labels": list(CLASS_NAMES),
                "values": confusion_matrix(
                    truths, predictions, labels=CLASS_NAMES
                ).tolist()
            }
        }

    return {
        "evaluation": "preliminary simulator evaluation; not a replacement for the full Demo Mode sweep",
        "run_id": run_id,
        "model": config.get("model_name"),
        "healthy_threshold": threshold,
        "feature_order": features,
        "measurement_rows": len(rows),
        "valid_feature_rows": len(valid_rows),
        "invalid_feature_rows": invalid_feature_rows,
        "rows_missing_live_prediction": missing_live_predictions,
        "stored_live_prediction_mismatches_vs_active_artifact": live_prediction_mismatches,
        "minimum_valid_rows_per_scenario_pwm_block": MIN_VALID_ROWS_PER_BLOCK,
        "validation_errors": errors,
        "sample_counts_by_scenario_and_pwm": sample_counts_by_scenario,
        "overall": metrics,
        "per_scenario": scenario_results,
        "per_pwm": pwm_results
    }


def load_active_task1_artifacts():
    with CONFIG_PATH.open(encoding="utf-8") as config_file:
        config = json.load(config_file)
    model = joblib.load(MODEL_PATH)
    return model, config


def fetch_rows(run_id, container, user, database):
    sql = build_export_sql(run_id)
    command = [
        "docker", "exec", "-i", container,
        "psql", "-U", user, "-d", database,
        "-c", sql
    ]
    completed = subprocess.run(
        command,
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8"
    )
    return parse_rows(completed.stdout, run_id)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--container", default="hydrosync-timescaledb")
    parser.add_argument("--db-user", default="hydrosync")
    parser.add_argument("--database", default="hydrosync")
    args = parser.parse_args()

    try:
        run_id = validate_run_id(args.run_id)
        rows = fetch_rows(run_id, args.container, args.db_user, args.database)
        model, config = load_active_task1_artifacts()
        report = compute_report(run_id, rows, model, config)
        print(json.dumps(report, indent=2))
        if report["validation_errors"]:
            return 2
        return 0
    except (ValueError, subprocess.CalledProcessError, OSError) as error:
        print(f"[QUICK DEMO EVALUATION] {error}", file=sys.stderr)
        if isinstance(error, subprocess.CalledProcessError) and error.stderr:
            print(error.stderr, file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
