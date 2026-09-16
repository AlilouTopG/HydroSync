"""
HydroSync Enterprise - Machine Learning & Signal Processing Engine
Language: Python 3.10+
Lead: AI / ML Engineer
"""

from fastapi import FastAPI
from pydantic import BaseModel
import numpy as np
from scipy.fft import rfft, rfftfreq

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
    fs = data.samplingRateHz
    n = len(samples)

    # FFT
    spectrum = np.abs(rfft(samples))
    frequencies = rfftfreq(n, d=1 / fs)

    # Ignore DC component
    spectrum[0] = 0

    # Find strongest frequency bins
    peak_indices = np.argsort(spectrum)[-5:][::-1]

    peaks = [
        {
            "frequency_hz": round(float(frequencies[i]), 2),
            "magnitude": round(float(spectrum[i]), 4),
        }
        for i in peak_indices
    ]

    return {"received": True, "samples": n, "sampling_rate_hz": fs, "peaks": peaks}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8000)
