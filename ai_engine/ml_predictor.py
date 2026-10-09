"""
HydroSync ML Predictor
Loads the trained Random Forest models (Task 1/2/3) and provides
single-row inference for the live telemetry pipeline.
"""

import json
import joblib
import numpy as np
from pathlib import Path

MODEL_DIR = Path(__file__).parent / "ml_models"


class MLPredictor:
    def __init__(self):
        # --- Task 1: 3-class state ---
        self.rf1 = joblib.load(MODEL_DIR / "task1_rf_model.pkl")
        self.le1 = joblib.load(MODEL_DIR / "task1_label_encoder.pkl")
        with open(MODEL_DIR / "task1_config.json") as f:
            cfg1 = json.load(f)
        self.healthy_idx = cfg1["healthy_class_index"]
        self.healthy_threshold = cfg1["tuned_threshold_healthy"]
        self.features = cfg1["features"]

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
        # build the input vector in the exact feature order the models expect
        x = np.array([[float(features[c]) for c in self.features]])

        # --- Task 1 (with tuned healthy threshold) ---
        p1 = self.rf1.predict_proba(x)[0]
        if p1[self.healthy_idx] >= self.healthy_threshold:
            state = "healthy"
        else:
            # decide between fault (idx 0) and operating_condition (idx 2)
            state = self.le1.classes_[0 if p1[0] >= p1[2] else 2]

        result = {
            "state": str(state),
            "state_confidence": float(p1.max()),
        }

        # --- Task 2 (only for fault rows) ---
        if state == "fault":
            p2 = self.rf2.predict_proba(x)[0]
            result["fault_type"] = str(self.le2.classes_[p2.argmax()])
            result["fault_confidence"] = float(p2.max())

        # --- Task 3 (only for operating_condition rows) ---
        elif state == "operating_condition":
            p3 = self.rf3.predict_proba(x)[0]
            result["operating_condition"] = str(self.le3.classes_[p3.argmax()])
            result["oc_confidence"] = float(p3.max())

        return result
