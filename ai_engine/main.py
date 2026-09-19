"""
HydroSync Enterprise - Machine Learning & Signal Processing Engine
Language: Python 3.10+
Lead: AI / ML Engineer
"""

from fastapi import FastAPI
from pydantic import BaseModel
import numpy as np
from scipy.fft import rfft, rfftfreq

latest_vibration = []
latest_fft = {"frequencies_hz": [], "magnitudes": []}

app = FastAPI(title="HydroSync AI Analytics Core")


class TelemetryPayload(BaseModel):
    vibration_rms: float
    motor_temp: float
    flow_rate: float


class VibrationPayload(BaseModel):
    vibrationWaveform: list[float]
    samplingRateHz: float
    bufferSize: int


@app.get("/")
def health_check():
    return {"status": "ONLINE", "runtime": "Python ML Core Active"}


@app.get("/diagnostics")
def get_diagnostics():
    return {"status": "ONLINE", "message": "HydroSync Python AI Engine is running"}


@app.post("/api/predict_anomaly")
def analyze_telemetry(data: TelemetryPayload):
    # خوارزمية فحص الاهتزاز ومعيار ISO 10816
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
    samples = np.array(data.vibrationWaveform, dtype=float)

    global latest_vibration
    latest_vibration = samples.tolist()

    fs = data.samplingRateHz
    n = len(samples)

    # ============================================================
    # 1. TIME-DOMAIN FEATURES
    # ============================================================

    vibration_rms = float(np.sqrt(np.mean(samples**2)))

    # ============================================================
    # 2. FFT / FREQUENCY-DOMAIN FEATURES
    # ============================================================

    spectrum = np.abs(rfft(samples))

    # Single-sided amplitude scaling
    spectrum[1:] *= 2 / n

    frequencies = rfftfreq(n, d=1 / fs)
    global latest_fft

    latest_fft = {
        "frequencies_hz": [round(float(f), 2) for f in frequencies],
        "magnitudes": [round(float(m), 4) for m in spectrum],
    }
    # Ignore DC component
    spectrum[0] = 0

    # ============================================================
    # 3. DOMINANT FREQUENCY
    # ============================================================

    dominant_index = int(np.argmax(spectrum))

    dominant_frequency = float(frequencies[dominant_index])
    dominant_amplitude = float(spectrum[dominant_index])

    # ============================================================
    # 4. 1× ROTATIONAL COMPONENT
    # ============================================================

    one_x_frequency = dominant_frequency
    one_x_amplitude = dominant_amplitude

    # ============================================================
    # 5. 2× ROTATIONAL COMPONENT
    # ============================================================

    target_2x = one_x_frequency * 2

    two_x_index = int(np.argmin(np.abs(frequencies - target_2x)))

    two_x_frequency = float(frequencies[two_x_index])
    two_x_amplitude = float(spectrum[two_x_index])

    # ============================================================
    # 6. BEARING-REGION COMPONENT
    # ============================================================

    # Current simulated/reference bearing-region frequency
    bearing_frequency_target = 167.97

    bearing_index = int(np.argmin(np.abs(frequencies - bearing_frequency_target)))

    bearing_frequency = float(frequencies[bearing_index])
    bearing_amplitude = float(spectrum[bearing_index])

    # ============================================================
    # 7. BEARING BAND RMS
    # ============================================================

    bearing_band_low = 160.0
    bearing_band_high = 175.0

    bearing_band_mask = (frequencies >= bearing_band_low) & (
        frequencies <= bearing_band_high
    )

    if np.any(bearing_band_mask):
        bearing_band_rms = float(np.sqrt(np.mean(spectrum[bearing_band_mask] ** 2)))
    else:
        bearing_band_rms = 0.0

    # ============================================================
    # 8. AMPLITUDE RATIOS
    # ============================================================

    two_x_to_one_x_ratio = (
        two_x_amplitude / one_x_amplitude if one_x_amplitude > 0 else 0.0
    )

    one_x_to_rms_ratio = one_x_amplitude / vibration_rms if vibration_rms > 0 else 0.0

    bearing_to_one_x_ratio = (
        bearing_amplitude / one_x_amplitude if one_x_amplitude > 0 else 0.0
    )

    bearing_band_to_rms_ratio = (
        bearing_band_rms / vibration_rms if vibration_rms > 0 else 0.0
    )

    # ============================================================
    # 9. SPECTRAL STATISTICS
    # ============================================================

    mean_spectrum = float(np.mean(spectrum))

    one_x_to_mean_spectrum_ratio = (
        one_x_amplitude / mean_spectrum if mean_spectrum > 0 else 0.0
    )

    two_x_to_mean_spectrum_ratio = (
        two_x_amplitude / mean_spectrum if mean_spectrum > 0 else 0.0
    )

    # Spectral energy
    spectral_energy = float(np.sum(spectrum**2))

    # Spectral centroid
    total_spectrum = float(np.sum(spectrum))

    if total_spectrum > 0:
        spectral_centroid = float(np.sum(frequencies * spectrum) / total_spectrum)
    else:
        spectral_centroid = 0.0

    # Spectral bandwidth
    if total_spectrum > 0:
        spectral_bandwidth = float(
            np.sqrt(
                np.sum(((frequencies - spectral_centroid) ** 2) * spectrum)
                / total_spectrum
            )
        )
    else:
        spectral_bandwidth = 0.0

    # ============================================================
    # 10. TOP FFT PEAKS
    # ============================================================

    peak_indices = np.argsort(spectrum)[-5:][::-1]

    peaks = [
        {
            "frequency_hz": round(float(frequencies[i]), 2),
            "magnitude": round(float(spectrum[i]), 4),
        }
        for i in peak_indices
    ]

    # ============================================================
    # 11. CONSOLE OUTPUT
    # ============================================================

    print("\n========== VIBRATION FEATURES ==========")

    print(f"RMS: {vibration_rms:.4f}")

    print(f"Dominant frequency: {dominant_frequency:.2f} Hz")

    print(f"Dominant amplitude: {dominant_amplitude:.4f}")

    print(f"1× frequency: {one_x_frequency:.2f} Hz")

    print(f"1× amplitude: {one_x_amplitude:.4f}")

    print(f"2× frequency: {two_x_frequency:.2f} Hz")

    print(f"2× amplitude: {two_x_amplitude:.4f}")

    print(f"Bearing-region frequency: {bearing_frequency:.2f} Hz")

    print(f"Bearing-region amplitude: {bearing_amplitude:.4f}")

    print(f"Bearing band RMS: {bearing_band_rms:.4f}")

    print(f"2× / 1× ratio: {two_x_to_one_x_ratio:.4f}")

    print(f"1× / RMS ratio: {one_x_to_rms_ratio:.4f}")

    print(f"1× / mean spectrum ratio: {one_x_to_mean_spectrum_ratio:.4f}")

    print(f"2× / mean spectrum ratio: {two_x_to_mean_spectrum_ratio:.4f}")

    print(f"Bearing / 1× ratio: {bearing_to_one_x_ratio:.4f}")

    print(f"Bearing band / RMS ratio: {bearing_band_to_rms_ratio:.4f}")

    print(f"Spectral energy: {spectral_energy:.4f}")

    print(f"Spectral centroid: {spectral_centroid:.2f} Hz")

    print(f"Spectral bandwidth: {spectral_bandwidth:.2f} Hz")

    print("========================================\n")

    # ============================================================
    # 12. RETURN FEATURE VECTOR
    # ============================================================

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

    uvicorn.run(app, host="127.0.0.1", port=8000)
