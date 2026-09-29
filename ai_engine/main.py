"""
HydroSync Enterprise - Machine Learning & Signal Processing Engine

Language: Python 3.10+

Lead: AI / ML Engineer
"""

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field, field_validator
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
import numpy as np
from scipy.fft import rfft, rfftfreq
from scipy.signal import find_peaks
import os
import math


DEBUG = False

latest_vibration = []
latest_fft = {"frequencies_hz": [], "magnitudes": []}
latest_multi_axis = None


app = FastAPI(title="HydroSync AI Analytics Core")


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request, exc):
    return JSONResponse(status_code=422, content={"detail": f"Invalid vibration payload: {exc}"})


class TelemetryPayload(BaseModel):
    vibration_rms: float
    motor_temp: float
    flow_rate: float


class VibrationPayload(BaseModel):
    vibrationWaveform: list[float] | None = None
    vibrationWaveforms: dict[str, list[float]] | None = None
    samplingRateHz: float = Field(gt=0, le=100_000)
    bufferSize: int | None = None

    @field_validator("vibrationWaveform")
    @classmethod
    def check_waveform(cls, v: list[float] | None) -> list[float] | None:
        if v is None:
            return v
        if len(v) < 32:
            raise ValueError("vibrationWaveform must have at least 32 samples")
        if len(v) > 4096:
            raise ValueError("vibrationWaveform must not exceed 4096 samples")
        if not all(math.isfinite(x) for x in v):
            raise ValueError("vibrationWaveform must not contain NaN or Infinity")
        return v

    @field_validator("vibrationWaveforms")
    @classmethod
    def check_waveforms_dict(cls, v: dict[str, list[float]] | None) -> dict[str, list[float]] | None:
        if v is None:
            return v
        required = {"x", "y", "z"}
        if not required.issubset(v.keys()):
            raise ValueError("vibrationWaveforms must contain keys 'x', 'y', and 'z'")
        lengths = [len(v[k]) for k in ("x", "y", "z")]
        if len(set(lengths)) != 1:
            raise ValueError("All axis waveforms must have equal length")
        if lengths[0] < 32:
            raise ValueError("Axis waveforms must have at least 32 samples")
        if lengths[0] > 4096:
            raise ValueError("Axis waveforms must not exceed 4096 samples")
        for key in ("x", "y", "z"):
            if not all(math.isfinite(x) for x in v[key]):
                raise ValueError(f"Axis '{key}' waveform contains non-finite values")
        return v


def compute_axis_analysis(x_raw: list[float] | np.ndarray, fs: float):
    x = np.asarray(x_raw, dtype=float)
    n = len(x)

    # Strip DC component
    x_dc = x - x.mean()
    vibration_rms = float(np.sqrt(np.mean(x_dc**2)))

    # Hanning window
    w = np.hanning(n)
    w_sum = float(w.sum()) if w.sum() > 0 else 1.0
    spectrum = 2.0 * np.abs(rfft(x_dc * w)) / w_sum
    spectrum[0] = 0.0
    if n % 2 == 0:
        spectrum[-1] /= 2

    frequencies = rfftfreq(n, d=1 / fs)

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

    # Real Peak Separation using find_peaks
    peak_idx, _ = find_peaks(spectrum, distance=3)
    top_peak_indices = peak_idx[np.argsort(spectrum[peak_idx])[::-1][:5]] if len(peak_idx) else np.array([], dtype=int)
    peaks = [
        {
            "frequency_hz": round(float(frequencies[p]), 2),
            "magnitude": round(float(spectrum[p]), 4),
        }
        for p in top_peak_indices
    ]

    features = {
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
    }

    fft = {
        "frequencies_hz": [round(float(f), 2) for f in frequencies],
        "magnitudes": [round(float(m), 4) for m in spectrum],
    }

    return features, fft, peaks


def safe_corr(a: list[float] | np.ndarray, b: list[float] | np.ndarray) -> float:
    arr_a = np.asarray(a, dtype=float)
    arr_b = np.asarray(b, dtype=float)
    std_a, std_b = float(np.std(arr_a)), float(np.std(arr_b))
    if std_a == 0.0 or std_b == 0.0:
        return 0.0
    r = float(np.corrcoef(arr_a, arr_b)[0, 1])
    return round(r, 4) if math.isfinite(r) else 0.0


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
    if not data.vibrationWaveform and not data.vibrationWaveforms:
        raise HTTPException(status_code=422, detail="Either vibrationWaveform or vibrationWaveforms must be provided")

    global latest_vibration, latest_fft, latest_multi_axis
    fs = data.samplingRateHz

    if data.vibrationWaveforms:
        axes_data = data.vibrationWaveforms
        feat_x, fft_x, peaks_x = compute_axis_analysis(axes_data["x"], fs)
        feat_y, fft_y, peaks_y = compute_axis_analysis(axes_data["y"], fs)
        feat_z, fft_z, peaks_z = compute_axis_analysis(axes_data["z"], fs)

        rms_x = feat_x["vibration_rms"]
        rms_y = feat_y["vibration_rms"]
        rms_z = feat_z["vibration_rms"]
        vector_rms = round(float(np.sqrt(rms_x**2 + rms_y**2 + rms_z**2)), 4)
        total_energy = round(feat_x["spectral_energy"] + feat_y["spectral_energy"] + feat_z["spectral_energy"], 4)
        rms_ratio_y_x = round(rms_y / rms_x, 4) if rms_x > 0 else 0.0
        rms_ratio_z_x = round(rms_z / rms_x, 4) if rms_x > 0 else 0.0

        corr_xy = safe_corr(axes_data["x"], axes_data["y"])
        corr_xz = safe_corr(axes_data["x"], axes_data["z"])
        corr_yz = safe_corr(axes_data["y"], axes_data["z"])

        combined_features = {
            "vector_rms": vector_rms,
            "total_spectral_energy": total_energy,
            "rms_ratio_y_x": rms_ratio_y_x,
            "rms_ratio_z_x": rms_ratio_z_x,
            "corr_xy": corr_xy,
            "corr_xz": corr_xz,
            "corr_yz": corr_yz,
        }

        multi_axis_out = {
            "version": "2.0",
            "axes_available": ["x", "y", "z"],
            "axes": {
                "x": {"features": feat_x, "fft": fft_x, "peaks": peaks_x},
                "y": {"features": feat_y, "fft": fft_y, "peaks": peaks_y},
                "z": {"features": feat_z, "fft": fft_z, "peaks": peaks_z},
            },
            "combined_features": combined_features,
        }

        latest_vibration = list(axes_data["x"])
        latest_fft = fft_x
        latest_multi_axis = multi_axis_out

        return {
            "received": True,
            "samples": len(axes_data["x"]),
            "sampling_rate_hz": fs,
            "features": feat_x,
            "fft": fft_x,
            "peaks": peaks_x,
            "multi_axis": multi_axis_out,
        }

    else:
        # Single waveform legacy path
        w_single = data.vibrationWaveform  # type: ignore
        feat_single, fft_single, peaks_single = compute_axis_analysis(w_single, fs)

        multi_axis_out = {
            "version": "1.0",
            "axes_available": ["x"],
            "axes": {
                "x": {"features": feat_single, "fft": fft_single, "peaks": peaks_single},
            },
            "combined_features": {
                "vector_rms": feat_single["vibration_rms"],
                "total_spectral_energy": feat_single["spectral_energy"],
                "rms_ratio_y_x": 0.0,
                "rms_ratio_z_x": 0.0,
                "corr_xy": 1.0,
                "corr_xz": 1.0,
                "corr_yz": 1.0,
            },
        }

        latest_vibration = list(w_single)
        latest_fft = fft_single
        latest_multi_axis = multi_axis_out

        return {
            "received": True,
            "samples": len(w_single),
            "sampling_rate_hz": fs,
            "features": feat_single,
            "fft": fft_single,
            "peaks": peaks_single,
            "multi_axis": multi_axis_out,
        }


@app.get("/vibration/latest")
def get_latest_vibration():
    return {
        "waveform": latest_vibration,
        "fft": latest_fft,
        "multi_axis": latest_multi_axis,
    }


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run(app, host="0.0.0.0", port=port)