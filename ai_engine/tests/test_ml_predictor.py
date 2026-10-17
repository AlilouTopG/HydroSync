import unittest
from pathlib import Path
from unittest.mock import patch
import warnings

import numpy as np
import pandas as pd

from ai_engine.ml_predictor import MLPredictor


class FakeClassifier:
    def __init__(self, classes, probabilities):
        self.classes_ = np.array(classes)
        self.probabilities = np.array([probabilities], dtype=float)
        self.inputs = []

    def predict_proba(self, values):
        self.inputs.append(values.copy())
        return self.probabilities


class FakeEncoder:
    def __init__(self, classes):
        self.classes_ = np.array(classes)


class MLPredictorTests(unittest.TestCase):
    def setUp(self):
        self.task1 = FakeClassifier(
            ["operating_condition", "healthy", "fault"],
            [0.31, 0.38, 0.31],
        )
        self.task2 = FakeClassifier(["bearing_fault", "bearing_wear"], [0.8, 0.2])
        self.task3 = FakeClassifier(["drought", "flood_risk"], [0.25, 0.75])
        artifacts = {
            "hydrosync_task1_model.joblib": self.task1,
            "task2_rf_model.pkl": self.task2,
            "task2_label_encoder.pkl": FakeEncoder(["bearing_fault", "bearing_wear"]),
            "task3_rf_model.pkl": self.task3,
            "task3_label_encoder.pkl": FakeEncoder(["drought", "flood_risk"]),
        }
        self.load_patch = patch(
            "ai_engine.ml_predictor.joblib.load",
            side_effect=lambda path: artifacts[Path(path).name],
        )
        self.mock_load = self.load_patch.start()
        self.addCleanup(self.load_patch.stop)
        self.predictor = MLPredictor()
        self.features = {
            feature: index + 1
            for index, feature in enumerate(reversed(self.predictor.features))
        }

    def test_loads_new_task1_artifact_and_preserves_task2_task3_loads(self):
        loaded_names = [Path(call.args[0]).name for call in self.mock_load.call_args_list]
        self.assertEqual(
            loaded_names,
            [
                "hydrosync_task1_model.joblib",
                "task2_rf_model.pkl",
                "task2_label_encoder.pkl",
                "task3_rf_model.pkl",
                "task3_label_encoder.pkl",
            ],
        )
        self.assertEqual(self.predictor.healthy_threshold, 0.38)
        self.assertEqual(self.predictor.task1_class_indices, {
            "fault": 2,
            "healthy": 1,
            "operating_condition": 0,
        })

    def test_preserves_configured_feature_order(self):
        self.predictor.predict(self.features)
        expected = [[float(self.features[name]) for name in self.predictor.features]]
        self.assertIsInstance(self.task1.inputs[0], pd.DataFrame)
        self.assertEqual(list(self.task1.inputs[0].columns), self.predictor.features)
        np.testing.assert_array_equal(self.task1.inputs[0].to_numpy(), expected)
        for model in (self.task2, self.task3):
            self.assertIsInstance(model.inputs[0], np.ndarray)
            np.testing.assert_array_equal(model.inputs[0], expected)

    def test_healthy_threshold_includes_exact_boundary_and_confidence(self):
        self.task1.probabilities = np.array([[0.31, 0.38, 0.31]])

        result = self.predictor.predict(self.features)

        self.assertEqual(result["state"], "healthy")
        self.assertEqual(result["state_confidence"], 0.38)

    def test_below_threshold_chooses_fault_and_reports_its_probability(self):
        self.task1.probabilities = np.array([[0.31, 0.37, 0.32]])

        result = self.predictor.predict(self.features)

        self.assertEqual(result["state"], "fault")
        self.assertEqual(result["state_confidence"], 0.32)

    def test_below_threshold_chooses_operating_condition(self):
        self.task1.probabilities = np.array([[0.33, 0.37, 0.30]])

        result = self.predictor.predict(self.features)

        self.assertEqual(result["state"], "operating_condition")
        self.assertEqual(result["state_confidence"], 0.33)

    def test_task2_task3_outputs_and_response_keys_remain_compatible(self):
        result = self.predictor.predict(self.features)

        self.assertEqual(
            set(result),
            {
                "state",
                "state_confidence",
                "fault_type",
                "fault_confidence",
                "operating_condition",
                "oc_confidence",
            },
        )
        self.assertEqual(result["fault_type"], "bearing_fault")
        self.assertEqual(result["fault_confidence"], 0.8)
        self.assertEqual(result["operating_condition"], "flood_risk")
        self.assertEqual(result["oc_confidence"], 0.75)

    def test_real_artifacts_load_and_keep_expected_task1_features(self):
        self.load_patch.stop()
        self.addCleanup(self.load_patch.start)

        predictor = MLPredictor()

        self.assertEqual(
            type(predictor.task1_model).__name__,
            "HistGradientBoostingClassifier",
        )
        self.assertEqual(
            list(predictor.task1_model.classes_),
            ["fault", "healthy", "operating_condition"],
        )
        self.assertEqual(predictor.task1_model.n_features_in_, 9)
        self.assertEqual(
            predictor.features,
            [
                "vibration_rms",
                "dominant_frequency_hz",
                "one_x_amplitude",
                "two_x_amplitude",
                "two_x_to_one_x_ratio",
                "spectral_energy",
                "motor_temp_c",
                "pwm_actual",
                "pwm_target",
            ],
        )
        values = {
            "vibration_rms": 8.5,
            "dominant_frequency_hz": 51.0,
            "one_x_amplitude": 8.0,
            "two_x_amplitude": 2.3,
            "two_x_to_one_x_ratio": 0.29,
            "spectral_energy": 220.0,
            "motor_temp_c": 34.0,
            "pwm_actual": 60,
            "pwm_target": 60,
        }
        ordered_values = [[float(values[name]) for name in predictor.features]]
        frame = pd.DataFrame(ordered_values, columns=predictor.features)
        self.assertEqual(
            list(frame.columns),
            [str(name) for name in predictor.task1_model.feature_names_in_],
        )
        with warnings.catch_warnings(record=True) as captured:
            warnings.simplefilter("always")
            array_probabilities = predictor.task1_model.predict_proba(
                np.asarray(ordered_values)
            )[0]
        self.assertTrue(any(
            "X does not have valid feature names" in str(item.message)
            for item in captured
        ))

        with warnings.catch_warnings(record=True) as captured:
            warnings.simplefilter("always")
            frame_probabilities = predictor.task1_model.predict_proba(frame)[0]
            result = predictor.predict(values)
        self.assertFalse(any(
            "X does not have valid feature names" in str(item.message)
            for item in captured
        ))
        np.testing.assert_allclose(frame_probabilities, array_probabilities)

        self.assertEqual(
            set(result),
            {
                "state",
                "state_confidence",
                "fault_type",
                "fault_confidence",
                "operating_condition",
                "oc_confidence",
            },
        )
        state_index = list(predictor.task1_model.classes_).index(result["state"])
        self.assertAlmostEqual(result["state_confidence"], frame_probabilities[state_index])


if __name__ == "__main__":
    unittest.main()
