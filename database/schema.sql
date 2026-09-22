-- ============================================================
-- HydroSync - TimescaleDB Schema
-- ============================================================
-- Purpose:
--   Historical SCADA telemetry, vibration waveforms,
--   ground-truth fault conditions, and AI-derived features.
--
-- Database:
--   hydrosync
--
-- PostgreSQL:
--   17
--
-- TimescaleDB:
--   2.30.1
-- ============================================================


-- ============================================================
-- 1. EXTENSIONS
-- ============================================================

CREATE EXTENSION IF NOT EXISTS timescaledb;


-- ============================================================
-- 2. EXPERIMENTS
-- ============================================================
-- One experiment represents one controlled data-collection run.
--
-- Examples:
--   rotor_imbalance_0
--   rotor_imbalance_50
--   rotor_imbalance_100
--   bearing_wear_progression
--   mixed_fault_test
--
-- This allows ML datasets to remain traceable and reproducible.

CREATE TABLE IF NOT EXISTS experiments (
    id BIGSERIAL PRIMARY KEY,

    name TEXT NOT NULL,

    description TEXT,

    source TEXT NOT NULL DEFAULT 'simulator'
        CHECK (source IN ('simulator', 'sensor', 'replay', 'other')),

    simulator_version TEXT,

    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    ended_at TIMESTAMPTZ,

    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CHECK (ended_at IS NULL OR ended_at >= started_at)
);


-- ============================================================
-- 3. TELEMETRY
-- ============================================================
-- Main time-series table.
--
-- One row = one telemetry observation.
--
-- A vibration waveform is stored as one FLOAT8[] instead of
-- creating 256+ database rows for every waveform.
--
-- Ground-truth values describe what the simulator actually
-- generated.
--
-- AI-derived values describe what the analysis pipeline found.

CREATE TABLE IF NOT EXISTS telemetry (
    time TIMESTAMPTZ NOT NULL,

    id BIGSERIAL,

    experiment_id BIGINT REFERENCES experiments(id)
        ON DELETE SET NULL,

    -- --------------------------------------------------------
    -- Machine / process state
    -- --------------------------------------------------------

    motor_temp_c DOUBLE PRECISION,

    tank_volume_pct DOUBLE PRECISION,

    pump_duty_pct DOUBLE PRECISION,

    flow_rate DOUBLE PRECISION,

    is_running BOOLEAN,

    -- --------------------------------------------------------
    -- Ground truth
    -- --------------------------------------------------------
    -- These represent the actual simulated machine condition.
    -- They must NOT be confused with AI predictions.

    imbalance_level_pct DOUBLE PRECISION
        CHECK (
            imbalance_level_pct IS NULL
            OR imbalance_level_pct BETWEEN 0 AND 100
        ),

    bearing_wear_pct DOUBLE PRECISION
        CHECK (
            bearing_wear_pct IS NULL
            OR bearing_wear_pct BETWEEN 0 AND 100
        ),

    cavitation_index DOUBLE PRECISION,

    -- --------------------------------------------------------
    -- Raw vibration signal
    -- --------------------------------------------------------

    vibration_waveform DOUBLE PRECISION[],

    sampling_rate_hz DOUBLE PRECISION
        CHECK (
            sampling_rate_hz IS NULL
            OR sampling_rate_hz > 0
        ),

    buffer_size INTEGER
        CHECK (
            buffer_size IS NULL
            OR buffer_size > 0
        ),

    vibration_rms DOUBLE PRECISION,

    -- --------------------------------------------------------
    -- AI / signal-processing derived features
    -- --------------------------------------------------------

    dominant_frequency_hz DOUBLE PRECISION,

    one_x_amplitude DOUBLE PRECISION,

    two_x_amplitude DOUBLE PRECISION,

    two_x_to_one_x_ratio DOUBLE PRECISION,

    one_x_to_rms_ratio DOUBLE PRECISION,

    spectral_energy DOUBLE PRECISION,

    crest_factor DOUBLE PRECISION,

    kurtosis DOUBLE PRECISION,

    -- --------------------------------------------------------
    -- AI anomaly / prediction results
    -- --------------------------------------------------------

    anomaly_score DOUBLE PRECISION,

    anomaly_detected BOOLEAN,

    predicted_fault TEXT,

    fault_confidence DOUBLE PRECISION
        CHECK (
            fault_confidence IS NULL
            OR fault_confidence BETWEEN 0 AND 1
        ),

    cavitation_probability DOUBLE PRECISION
        CHECK (
            cavitation_probability IS NULL
            OR cavitation_probability BETWEEN 0 AND 1
        ),

    bearing_probability DOUBLE PRECISION
        CHECK (
            bearing_probability IS NULL
            OR bearing_probability BETWEEN 0 AND 1
        ),

    imbalance_probability DOUBLE PRECISION
        CHECK (
            imbalance_probability IS NULL
            OR imbalance_probability BETWEEN 0 AND 1
        ),

    -- --------------------------------------------------------
    -- Complete FFT output
    -- --------------------------------------------------------

    fft_frequencies_hz DOUBLE PRECISION[],

    fft_magnitudes DOUBLE PRECISION[],

    -- --------------------------------------------------------
    -- Flexible AI metadata
    -- --------------------------------------------------------
    -- Useful when the AI pipeline evolves without requiring
    -- a schema migration for every new experimental feature.

    features JSONB NOT NULL DEFAULT '{}'::jsonb,

    model_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

    -- --------------------------------------------------------
    -- Data provenance
    -- --------------------------------------------------------

    collection_source TEXT NOT NULL DEFAULT 'simulator',

    notes TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    PRIMARY KEY (time, id)
);


-- ============================================================
-- 4. CONVERT TELEMETRY INTO A HYPERTABLE
-- ============================================================

SELECT create_hypertable(
    'telemetry',
    by_range('time'),
    if_not_exists => TRUE
);


-- ============================================================
-- 5. INDEXES
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_telemetry_experiment_time
    ON telemetry (experiment_id, time DESC);

CREATE INDEX IF NOT EXISTS idx_telemetry_fault_time
    ON telemetry (predicted_fault, time DESC);

CREATE INDEX IF NOT EXISTS idx_telemetry_anomaly_time
    ON telemetry (anomaly_detected, time DESC);

CREATE INDEX IF NOT EXISTS idx_telemetry_imbalance
    ON telemetry (imbalance_level_pct, time DESC);

CREATE INDEX IF NOT EXISTS idx_telemetry_bearing_wear
    ON telemetry (bearing_wear_pct, time DESC);


-- ============================================================
-- 6. FAULT EVENTS
-- ============================================================
-- This table is intentionally separate from telemetry.
--
-- Telemetry = continuous measurements.
-- Fault event = an identified period/event.
--
-- This will be useful later for dashboards, incident analysis,
-- and supervised ML labeling.

CREATE TABLE IF NOT EXISTS fault_events (
    id BIGSERIAL PRIMARY KEY,

    experiment_id BIGINT REFERENCES experiments(id)
        ON DELETE SET NULL,

    fault_type TEXT NOT NULL,

    started_at TIMESTAMPTZ NOT NULL,

    ended_at TIMESTAMPTZ,

    severity TEXT
        CHECK (
            severity IS NULL
            OR severity IN ('low', 'medium', 'high', 'critical')
        ),

    confidence DOUBLE PRECISION
        CHECK (
            confidence IS NULL
            OR confidence BETWEEN 0 AND 1
        ),

    source TEXT NOT NULL DEFAULT 'ai',

    details JSONB NOT NULL DEFAULT '{}'::jsonb,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CHECK (ended_at IS NULL OR ended_at >= started_at)
);


CREATE INDEX IF NOT EXISTS idx_fault_events_time
    ON fault_events (started_at DESC);

CREATE INDEX IF NOT EXISTS idx_fault_events_type
    ON fault_events (fault_type, started_at DESC);


-- ============================================================
-- 7. BASIC TELEMETRY VIEW
-- ============================================================
-- Convenient view for analysis and debugging.

CREATE OR REPLACE VIEW telemetry_summary AS
SELECT
    time,
    experiment_id,
    vibration_rms,
    dominant_frequency_hz,
    one_x_amplitude,
    two_x_amplitude,
    two_x_to_one_x_ratio,
    bearing_wear_pct,
    imbalance_level_pct,
    cavitation_index,
    motor_temp_c,
    pump_duty_pct,
    flow_rate,
    anomaly_score,
    anomaly_detected,
    predicted_fault,
    fault_confidence
FROM telemetry;


-- ============================================================
-- 8. RECENT MACHINE HEALTH VIEW
-- ============================================================
-- Returns the most recent observation for each experiment.

CREATE OR REPLACE VIEW latest_experiment_telemetry AS
SELECT DISTINCT ON (experiment_id)
    experiment_id,
    time,
    vibration_rms,
    dominant_frequency_hz,
    one_x_amplitude,
    two_x_amplitude,
    two_x_to_one_x_ratio,
    bearing_wear_pct,
    imbalance_level_pct,
    cavitation_index,
    motor_temp_c,
    pump_duty_pct,
    flow_rate,
    anomaly_score,
    anomaly_detected,
    predicted_fault,
    fault_confidence
FROM telemetry
WHERE experiment_id IS NOT NULL
ORDER BY experiment_id, time DESC;


-- ============================================================
-- 9. CONTINUOUS AGGREGATE
-- ============================================================
-- One-minute vibration statistics.
--
-- This avoids repeatedly scanning raw telemetry when the
-- dashboard needs historical RMS trends.

CREATE MATERIALIZED VIEW vibration_rms_1min
WITH (timescaledb.continuous) AS
SELECT
    time_bucket(INTERVAL '1 minute', time) AS bucket,
    experiment_id,

    AVG(vibration_rms) AS avg_vibration_rms,

    MAX(vibration_rms) AS max_vibration_rms,

    MIN(vibration_rms) AS min_vibration_rms,

    AVG(motor_temp_c) AS avg_motor_temp_c,

    AVG(pump_duty_pct) AS avg_pump_duty_pct,

    AVG(anomaly_score) AS avg_anomaly_score,

    COUNT(*) AS sample_count

FROM telemetry

GROUP BY
    bucket,
    experiment_id
WITH NO DATA;


-- ============================================================
-- 10. CONTINUOUS AGGREGATE REFRESH POLICY
-- ============================================================

SELECT add_continuous_aggregate_policy(
    'vibration_rms_1min',
    start_offset => INTERVAL '2 hours',
    end_offset => INTERVAL '1 minute',
    schedule_interval => INTERVAL '1 minute',
    if_not_exists => TRUE
);


-- ============================================================
-- 11. DATA RETENTION / COMPRESSION
-- ============================================================
-- We are deliberately NOT enabling an automatic retention
-- policy yet.
--
-- HydroSync is currently in development and we want to keep
-- the historical training data.
--
-- Compression can be added after we have accumulated enough
-- real data and confirmed the production workload.
-- ============================================================


-- ============================================================
-- END OF SCHEMA
-- ============================================================