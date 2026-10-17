import pandas as pd

df = pd.read_csv(
    r"E:\HydroSync\HydroSync\multiaxis_hydrosync_dataset.csv",
    usecols=lambda c: c != "waveform",
)
train = pd.read_csv(
    r"C:\Users\pc\Downloads\multiaxis_hydrosync_dataset.csv",
    usecols=lambda c: c != "waveform",
)

# class proportions
print("=== class proportions ===")
for name, d in [("train", train), ("new", df)]:

    def ts(row):
        if row["is_baseline"]:
            return "healthy"
        if row["fault_type"] in ("none", "dry_run"):
            return "operating_condition"
        return "fault"

    counts = d.apply(ts, axis=1).value_counts(normalize=True).round(3)
    print(f"{name}: {counts.to_dict()}")
print()

# per-class feature means for operating_condition rows specifically
print("=== OC rows: feature means (train vs new) ===")
feats = [
    "vibration_rms",
    "one_x_amplitude",
    "two_x_amplitude",
    "spectral_energy",
    "motor_temp_c",
]
tr_oc = train[
    train["fault_type"].isin(["none", "dry_run"]) | train["is_baseline"] == False
]
tr_oc = train[
    (train["fault_type"] == "none") & (train["is_baseline"] == False)
    | (train["fault_type"] == "dry_run")
]
nw_oc = df[
    (df["fault_type"] == "none") & (df["is_baseline"] == False)
    | (df["fault_type"] == "dry_run")
]
print("train OC rows:", len(tr_oc))
print("new OC rows:  ", len(nw_oc))
print()
print(
    pd.DataFrame({"train": tr_oc[feats].mean(), "new": nw_oc[feats].mean()})
    .round(3)
    .to_string()
)
