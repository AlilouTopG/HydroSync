import unittest

import numpy as np

from evaluate_quick_demo import (
    CLASS_NAMES,
    SCENARIO_TO_LABEL,
    build_export_sql,
    compute_report,
    load_active_task1_artifacts,
    parse_rows,
    task1_truth,
)


RUN_ID = "01234567-89ab-cdef-0123-456789abcdef"


class FakeTask1Model:
    classes_ = np.array(["fault", "healthy", "operating_condition"])
    n_features_in_ = 9
    feature_names_in_ = np.array([
        "vibration_rms",
        "dominant_frequency_hz",
        "one_x_amplitude",
        "two_x_amplitude",
        "two_x_to_one_x_ratio",
        "spectral_energy",
        "motor_temp_c",
        "pwm_actual",
        "pwm_target",
    ])

    def predict_proba(self, matrix):
        return np.tile([0.2, 0.6, 0.2], (len(matrix), 1))


class QuickDemoEvaluationTests(unittest.TestCase):
    def test_active_hgb_artifact_and_fixed_threshold_are_the_evaluation_target(self):
        model, config = load_active_task1_artifacts()

        self.assertEqual(type(model).__name__, "HistGradientBoostingClassifier")
        self.assertEqual(list(model.classes_), list(CLASS_NAMES))
        self.assertEqual(config["healthy_threshold"], 0.38)
        self.assertEqual(len(config["features"]), 9)

    def test_ground_truth_mapping_covers_all_nine_scenarios(self):
        self.assertEqual(set(SCENARIO_TO_LABEL), {
            "healthy",
            "rotor_imbalance",
            "bearing_wear",
            "bearing_fault",
            "cavitation",
            "motor_overheat",
            "dry_run",
            "drought",
            "flood_risk",
        })
        self.assertEqual(task1_truth("healthy"), "healthy")
        self.assertEqual(task1_truth("dry_run"), "fault")
        self.assertEqual(task1_truth("drought"), "operating_condition")
        self.assertEqual(task1_truth("flood_risk"), "operating_condition")
        for scenario in (
            "rotor_imbalance",
            "bearing_wear",
            "bearing_fault",
            "cavitation",
            "motor_overheat",
        ):
            self.assertEqual(task1_truth(scenario), "fault")
        with self.assertRaisesRegex(ValueError, "Unknown quick Demo Mode scenario"):
            task1_truth("unrecognized")

    def test_export_query_is_restricted_to_requested_run_measurements(self):
        sql = build_export_sql(RUN_ID)
        self.assertIn(f"->>'demo_run_id' = '{RUN_ID}'", sql)
        self.assertIn("->>'demo_run_mode' = 'quick'", sql)
        self.assertIn("->>'demo_phase' = 'measurement'", sql)
        self.assertIn("->>'demo_mode' = 'true'", sql)
        with self.assertRaisesRegex(ValueError, "run ID must be a UUID"):
            build_export_sql("old-kaggle-test-predictions")

    def test_rows_from_another_run_are_rejected(self):
        raw = (
            "demo_run_id,demo_state,demo_pwm,demo_phase,demo_run_mode,ml_state\n"
            f"{RUN_ID},healthy,40,measurement,quick,healthy\n"
            "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee,healthy,40,measurement,quick,healthy\n"
        )
        with self.assertRaisesRegex(ValueError, "outside requested run"):
            parse_rows(raw, RUN_ID)

    def test_report_requires_samples_for_every_scenario_and_pwm_block(self):
        features = list(FakeTask1Model.feature_names_in_)
        rows = []
        for scenario in SCENARIO_TO_LABEL:
            for pwm in (40, 60, 80):
                for _ in range(5):
                    row = {
                        "demo_run_id": RUN_ID,
                        "demo_state": scenario,
                        "demo_pwm": str(pwm),
                        "demo_phase": "measurement",
                        "demo_run_mode": "quick",
                        "ml_state": "healthy",
                    }
                    row.update({feature: "1.0" for feature in features})
                    rows.append(row)
        config = {
            "model_name": "hgb_unweighted",
            "classes": list(CLASS_NAMES),
            "features": features,
            "healthy_threshold": 0.38,
        }

        report = compute_report(RUN_ID, rows, FakeTask1Model(), config)

        self.assertEqual(report["valid_feature_rows"], 9 * 3 * 5)
        self.assertEqual(report["validation_errors"], [])
        self.assertEqual(report["overall"]["confusion_matrix"]["labels"], list(CLASS_NAMES))
        self.assertEqual(set(report["per_scenario"]), set(SCENARIO_TO_LABEL))
        self.assertEqual(set(report["per_pwm"]), {"40", "60", "80"})
        self.assertTrue(all(
            report["per_scenario"][scenario]["pwm_blocks"][str(pwm)]["rows"] == 5
            for scenario in SCENARIO_TO_LABEL
            for pwm in (40, 60, 80)
        ))


if __name__ == "__main__":
    unittest.main()
