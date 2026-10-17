"""
HydroSync ML Predictor
Loads the trained Task 1, Task 2, and Task 3 models and provides
single-row inference for the live telemetry pipeline.
"""

import json
import joblib
import numpy as np
import pandas as pd
from pathlib import Path

MODEL_DIR = Path(__file__).parent / "ml_models"


class MLPredictor:
    def __init__(self):
        # --- Task 1: grouped-split HistGradientBoosting state model ---
        self.task1_model = joblib.load(MODEL_DIR / "hydrosync_task1_model.joblib")
        with open(MODEL_DIR / "hydrosync_task1_config.json", encoding="utf-8") as f:
            cfg1 = json.load(f)
        self.features = cfg1["features"]
        self.healthy_threshold = float(cfg1["healthy_threshold"])

        required_classes = {"fault", "healthy", "operating_condition"}
        model_classes = [str(name) for name in self.task1_model.classes_]
        if len(model_classes) != len(set(model_classes)) or set(model_classes) != required_classes:
            raise ValueError(
                "Task 1 model classes must be exactly fault, healthy, "
                "and operating_condition"
            )
        if (not isinstance(self.features, list) or len(self.features) != 9 or
                not all(isinstance(name, str) and name for name in self.features) or
                len(set(self.features)) != len(self.features)):
            raise ValueError("Task 1 config must define nine unique, ordered feature names")
        model_feature_count = getattr(self.task1_model, "n_features_in_", None)
        if model_feature_count is not None and model_feature_count != len(self.features):
            raise ValueError("Task 1 config feature count does not match the model")
        model_feature_names = getattr(self.task1_model, "feature_names_in_", None)
        if (model_feature_names is not None and
                [str(name) for name in model_feature_names] != self.features):
            raise ValueError("Task 1 config feature order does not match the model")
        if not 0 <= self.healthy_threshold <= 1:
            raise ValueError("Task 1 healthy threshold must be between 0 and 1")
        self.task1_class_indices = {
            class_name: model_classes.index(class_name)
            for class_name in required_classes
        }

        # --- Task 2: 5-class fault subtype ---
        self.rf2 = joblib.load(MODEL_DIR / "task2_rf_model.pkl")
        self.le2 = joblib.load(MODEL_DIR / "task2_label_encoder.pkl")

        # --- Task 3: 3-class operating condition ---
        self.rf3 = joblib.load(MODEL_DIR / "task3_rf_model.pkl")
        self.le3 = joblib.load(MODEL_DIR / "task3_label_encoder.pkl")

    def predict(self, features: dict) -> dict:
        """
        features: dict with keys matching self.features (9 values)
        returns: dict with state, fault_type / operating_condition, confidences
        """
        # Build the Task 1 frame in the fitted model's configured feature order.
        task1_input = pd.DataFrame(
            [[float(features[name]) for name in self.features]],
            columns=self.features,
        )

        # Task 2 and Task 3 retain their original NumPy input behavior.
        x = np.array([[float(features[c]) for c in self.features]])

        # --- Task 1 (with the configured healthy threshold) ---
        p1 = self.task1_model.predict_proba(task1_input)[0]
        healthy_idx = self.task1_class_indices["healthy"]
        fault_idx = self.task1_class_indices["fault"]
        operating_condition_idx = self.task1_class_indices["operating_condition"]
        if p1[healthy_idx] >= self.healthy_threshold:
            state = "healthy"
        elif p1[fault_idx] >= p1[operating_condition_idx]:
            state = "fault"
        else:
            state = "operating_condition"

        result = {
            "state": str(state),
            "state_confidence": float(p1[self.task1_class_indices[state]]),
        }

        # Keep both task heads available for independent evaluation against their
        # training sets; Task 1 remains the sole top-level state prediction.
        p2 = self.rf2.predict_proba(x)[0]
        result["fault_type"] = str(self.le2.classes_[p2.argmax()])
        result["fault_confidence"] = float(p2.max())

        p3 = self.rf3.predict_proba(x)[0]
        result["operating_condition"] = str(self.le3.classes_[p3.argmax()])
        result["oc_confidence"] = float(p3.max())

        return result
