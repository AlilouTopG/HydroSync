"""
HydroSync Enterprise - Machine Learning & Signal Processing Engine

Language: Python 3.10+

Lead: AI / ML Engineer

"""

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field, field_validator
import numpy as np
from scipy.fft import rfft, rfftfreq
from scipy.signal import find_peaks
import os


DEBUG = False

latest_vibration = []
latest_fft = {"frequencies_hz": [], "magnitudes": []}


app = FastAPI(title="HydroSync AI Analytics Core")


class TelemetryPayload(BaseModel):
    vibration_rms: float
    motor_temp: float
    flow_rate: float


class VibrationPayload(BaseModel):
    vibrationWaveform: list[float] = Field(min_length=32, max_length=4096)
    samplingRateHz: float = Field(gt=0, le=100_000)
    bufferSize: int | None = None

    @field_validator("vibrationWaveform")
    @classmethod
    def check_waveform(cls, v: list[float]) -> list[float]:
        if len(v) < 32:
            raise ValueError("vibrationWaveform must have at least 32 samples")
        if len(v) > 4096:
            raise ValueError("vibrationWaveform must not exceed 4096 samples")
        return v


@app.get("/")
def health_check():
    return {"status": "ONLINE", "runtime": "Python ML Core Active"}


@app.get("/diagnostics")
def get_diagnostics():
    return {"status": "ONLINE", "message": "HydroSync Python AI Engine is running"}


@app.post("/api/predict_anomaly")
def analyze_telemetry(data: TelemetryPayload):
    status = "OPTIMAL"
    anomaly_score = round(data.vibration_rms / 4.5, 3)

    if data.vibration_rms >= 4.5 or data.motor_temp > 85.0:
        status = "CRITICAL_ZONE_D"
    elif data.vibration_rms >= 2.8:
        status = "WARNING_ZONE_C"

    return {
        "status": status,
        "anomaly_score": anomaly_score,
        "cavitation_detected": data.vibration_rms > 3.8 and data.flow_rate < 15.0,
    }


@app.post("/vibration")
def receive_vibration(data: VibrationPayload):
    x = np.asarray(data.vibrationWaveform, dtype=float)
    n, fs = len(x), data.samplingRateHz

    # Strip DC component
    x = x - x.mean()
    vibration_rms = float(np.sqrt(np.mean(x**2)))

    # Hanning window
    w = np.hanning(n)
    spectrum = 2.0 * np.abs(rfft(x * w)) / w.sum()
    spectrum[0] = 0.0
    if n % 2 == 0:
        spectrum[-1] /= 2

    frequencies = rfftfreq(n, d=1 / fs)

    global latest_vibration, latest_fft
    latest_vibration = x.tolist()
    latest_fft = {
        "frequencies_hz": [round(float(f), 2) for f in frequencies],
        "magnitudes": [round(float(m), 4) for m in spectrum],
    }

    # Dominant frequency
    dominant_index = int(np.argmax(spectrum))
    dominant_frequency = float(frequencies[dominant_index])
    dominant_amplitude = float(spectrum[dominant_index])

    # 1x rotational component in 30-70 Hz band
    run = (frequencies >= 30) & (frequencies <= 70)
    one_x_idx = int(np.argmax(np.where(run, spectrum, 0))) if np.any(run) else 0
    one_x_frequency = float(frequencies[one_x_idx])
    one_x_amplitude = float(spectrum[one_x_idx])

    # Bearing-region harmonics tracking at 3.56x shaft speed
    bearing_frequency_target = 3.56 * one_x_frequency
    band = (frequencies >= 0.95 * bearing_frequency_target) & (frequencies <= 1.05 * bearing_frequency_target)

    # Bearing band RMS
    bearing_band_low = max(0.95 * bearing_frequency_target - 5, 0)
    bearing_band_high = min(1.05 * bearing_frequency_target + 5, fs / 2)
    bearing_band_mask = (frequencies >= bearing_band_low) & (frequencies <= bearing_band_high)
    if np.any(bearing_band_mask):
        bearing_band_rms = float(np.sqrt(np.mean(spectrum[bearing_band_mask] ** 2)))
    else:
        bearing_band_rms = 0.0

    # 2x rotational
    target_2x = one_x_frequency * 2
    two_x_index = int(np.argmin(np.abs(frequencies - target_2x)))
    two_x_frequency = float(frequencies[two_x_index])
    two_x_amplitude = float(spectrum[two_x_index])

    # Bearing frequency at target
    bearing_index = int(np.argmin(np.abs(frequencies - bearing_frequency_target)))
    bearing_frequency = float(frequencies[bearing_index])
    bearing_amplitude = float(spectrum[bearing_index])

    # Amplitude ratios
    two_x_to_one_x_ratio = two_x_amplitude / one_x_amplitude if one_x_amplitude > 0 else 0.0
    one_x_to_rms_ratio = one_x_amplitude / vibration_rms if vibration_rms > 0 else 0.0
    bearing_to_one_x_ratio = bearing_amplitude / one_x_amplitude if one_x_amplitude > 0 else 0.0
    bearing_band_to_rms_ratio = bearing_band_rms / vibration_rms if vibration_rms > 0 else 0.0

    # Spectral stats
    mean_spectrum = float(np.mean(spectrum))
    one_x_to_mean_spectrum_ratio = one_x_amplitude / mean_spectrum if mean_spectrum > 0 else 0.0
    two_x_to_mean_spectrum_ratio = two_x_amplitude / mean_spectrum if mean_spectrum > 0 else 0.0
    spectral_energy = float(np.sum(spectrum**2))
    total_spectrum = float(np.sum(spectrum))

    if total_spectrum > 0:
        spectral_centroid = float(np.sum(frequencies * spectrum) / total_spectrum)
        spectral_bandwidth = float(
            np.sqrt(np.sum(((frequencies - spectral_centroid) ** 2) * spectrum) / total_spectrum)
        )
    else:
        spectral_centroid = 0.0
        spectral_bandwidth = 0.0

    # Top FFT peaks
    peak_indices = np.argsort(spectrum)[-5:][::-1]
    peaks = [
        {
            "frequency_hz": round(float(frequencies[i]), 2),
            "magnitude": round(float(spectrum[i]), 4),
        }
        for i in peak_indices
    ]

    if DEBUG:
        print("\n========== VIBRATION FEATURES ==========")
        print(f"RMS: {vibration_rms:.4f}")
        print(f"Dominant frequency: {dominant_frequency:.2f} Hz")
        print(f"1x frequency: {one_x_frequency:.2f} Hz")
        print(f"Bearing target: {bearing_frequency_target:.2f} Hz")
        print(f"Bearing band RMS: {bearing_band_rms:.4f}")
        print("========================================\n")

    return {
        "received": True,
        "samples": n,
        "sampling_rate_hz": fs,
        "features": {
            "vibration_rms": round(vibration_rms, 4),
            "dominant_frequency_hz": round(dominant_frequency, 2),
            "dominant_amplitude": round(dominant_amplitude, 4),
            "one_x_frequency_hz": round(one_x_frequency, 2),
            "one_x_amplitude": round(one_x_amplitude, 4),
            "two_x_frequency_hz": round(two_x_frequency, 2),
            "two_x_amplitude": round(two_x_amplitude, 4),
            "bearing_frequency_hz": round(bearing_frequency, 2),
            "bearing_amplitude": round(bearing_amplitude, 4),
            "bearing_band_rms": round(bearing_band_rms, 4),
            "two_x_to_one_x_ratio": round(two_x_to_one_x_ratio, 4),
            "one_x_to_rms_ratio": round(one_x_to_rms_ratio, 4),
            "one_x_to_mean_spectrum_ratio": round(one_x_to_mean_spectrum_ratio, 4),
            "two_x_to_mean_spectrum_ratio": round(two_x_to_mean_spectrum_ratio, 4),
            "bearing_to_one_x_ratio": round(bearing_to_one_x_ratio, 4),
            "bearing_band_to_rms_ratio": round(bearing_band_to_rms_ratio, 4),
            "spectral_energy": round(spectral_energy, 4),
            "spectral_centroid_hz": round(spectral_centroid, 2),
            "spectral_bandwidth_hz": round(spectral_bandwidth, 2),
        },
        "fft": {
            "frequencies_hz": [round(float(f), 2) for f in frequencies],
            "magnitudes": [round(float(m), 4) for m in spectrum],
        },
        "peaks": peaks,
    }


@app.get("/vibration/latest")
def get_latest_vibration():
    return {"waveform": latest_vibration, "fft": latest_fft}


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run(app, host="0.0.0.0", port=port)