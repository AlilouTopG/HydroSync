"""
HydroSync ML Inference
Loads trained models and predicts pump state from a single feature row.
"""
import json
import joblib
import numpy as np
from pathlib import Path

MODEL_DIR = Path(__file__).parent / 'models'
CONFIG_DIR = Path(__file__).parent / 'configs'


class HydroSyncPredictor:
    def __init__(self):
        # Task 1
        self.rf1 = joblib.load(MODEL_DIR / 'task1_rf_model.pkl')
        self.le1 = joblib.load(MODEL_DIR / 'task1_label_encoder.pkl')
        with open(CONFIG_DIR / 'task1_config.json') as f:
            self.cfg1 = json.load(f)
        self.healthy_idx = self.cfg1['healthy_class_index']
        self.healthy_threshold = self.cfg1['tuned_threshold_healthy']
        self.features = self.cfg1['features']

        # Task 2
        self.rf2 = joblib.load(MODEL_DIR / 'task2_rf_model.pkl')
        self.le2 = joblib.load(MODEL_DIR / 'task2_label_encoder.pkl')

        # Task 3
        self.rf3 = joblib.load(MODEL_DIR / 'task3_rf_model.pkl')
        self.le3 = joblib.load(MODEL_DIR / 'task3_label_encoder.pkl')

    def predict(self, features: dict) -> dict:
        """Predict pump state from a dict of feature values."""
        X = np.array([[features[c] for c in self.features]])

        # --- Task 1 with tuned healthy threshold ---
        proba = self.rf1.predict_proba(X)[0]
        if proba[self.healthy_idx] >= self.healthy_threshold:
            state = 'healthy'
        else:
            # decide between fault (idx 0) and operating_condition (idx 2)
            state = self.le1.classes_[0 if proba[0] >= proba[2] else 2]

        result = {'state': state, 'confidence': float(max(proba))}

        # --- route to Task 2 or Task 3 ---
        if state == 'fault':
            p2 = self.rf2.predict_proba(X)[0]
            result['fault_type'] = str(self.le2.classes_[p2.argmax()])
            result['fault_confidence'] = float(p2.max())

        elif state == 'operating_condition':
            p3 = self.rf3.predict_proba(X)[0]
            result['operating_condition'] = str(self.le3.classes_[p3.argmax()])
            result['oc_confidence'] = float(p3.max())

        return result


# --- quick self-test ---
if __name__ == '__main__':
    predictor = HydroSyncPredictor()
    example = {
        'vibration_rms': 8.5,
        'dominant_frequency_hz': 51.0,
        'one_x_amplitude': 8.0,
        'two_x_amplitude': 2.3,
        'two_x_to_one_x_ratio': 0.29,
        'spectral_energy': 220.0,
        'motor_temp_c': 34.0,
        'pwm_actual': 60,
        'pwm_target': 60,
    }
    print(predictor.predict(example))