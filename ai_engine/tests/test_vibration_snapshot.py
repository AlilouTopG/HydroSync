import sys
import unittest
from pathlib import Path

import numpy as np

AI_ENGINE_DIR = Path(__file__).resolve().parents[1]
if str(AI_ENGINE_DIR) not in sys.path:
    sys.path.insert(0, str(AI_ENGINE_DIR))

import main as ai_main


class VibrationSnapshotTests(unittest.TestCase):
    def setUp(self):
        self.previous_snapshot = ai_main.latest_vibration_snapshot

    def tearDown(self):
        ai_main.latest_vibration_snapshot = self.previous_snapshot

    def test_post_and_latest_preserve_metadata_and_analysis_as_one_snapshot(self):
        sample_id = "waveform-abc123"
        observed_at = "2026-10-22T18:30:00.000Z"
        sample_count = 128
        time_values = np.arange(sample_count) / 1000
        waveform = np.sin(2 * np.pi * 50 * time_values).tolist()
        payload = ai_main.VibrationPayload(
            vibrationWaveforms={
                "x": waveform,
                "y": [value * 0.5 for value in waveform],
                "z": [value * 0.25 for value in waveform],
            },
            samplingRateHz=1000,
            sampleId=sample_id,
            observedAt=observed_at,
        )

        post_result = ai_main.receive_vibration(payload)
        latest_result = ai_main.get_latest_vibration()

        self.assertEqual(post_result["sampleId"], sample_id)
        self.assertEqual(post_result["observedAt"], observed_at)
        self.assertEqual(latest_result["sampleId"], sample_id)
        self.assertEqual(latest_result["observedAt"], observed_at)
        self.assertEqual(latest_result["features"], post_result["features"])
        self.assertEqual(latest_result["fft"], post_result["fft"])
        self.assertEqual(latest_result["multi_axis"], post_result["multi_axis"])
        self.assertEqual(latest_result["samples"], sample_count)

    def test_missing_capture_metadata_is_returned_as_missing(self):
        payload = ai_main.VibrationPayload(
            vibrationWaveform=np.sin(np.arange(128) / 3).tolist(),
            samplingRateHz=1000,
        )

        result = ai_main.receive_vibration(payload)
        latest_result = ai_main.get_latest_vibration()

        self.assertIsNone(result["sampleId"])
        self.assertIsNone(result["observedAt"])
        self.assertIsNone(latest_result["sampleId"])
        self.assertIsNone(latest_result["observedAt"])
        self.assertEqual(latest_result["features"], result["features"])


if __name__ == "__main__":
    unittest.main()
