[CmdletBinding()]
param(
    [string]$ArchiveUrl = "https://github.com/AlilouTopG/HydroSync/releases/download/ml-artifacts-v1/hydrosync-ml-artifacts-v1.zip",
    [string]$ExpectedSha256 = "75E0483F13F066A8ACE646ACD9AE82D05FF30ACD0FA07A22BBB51736DAF304C6"
)

$ErrorActionPreference = "Stop"

if ($ExpectedSha256 -notmatch "^[A-Fa-f0-9]{64}$") {
    throw "ExpectedSha256 must be the pinned 64-character SHA-256 of the model archive."
}

$expectedFiles = @(
    "ai_engine/ml_models/hydrosync_task1_config.json",
    "ai_engine/ml_models/hydrosync_task1_model.joblib",
    "ai_engine/ml_models/task2_label_encoder.pkl",
    "ai_engine/ml_models/task2_rf_model.pkl",
    "ai_engine/ml_models/task3_label_encoder.pkl",
    "ai_engine/ml_models/task3_rf_model.pkl"
)

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) (
    "hydrosync-ml-artifacts-" + [guid]::NewGuid().ToString("N")
)
$archivePath = Join-Path $tempRoot "hydrosync-ml-artifacts-v1.zip"
$extractPath = Join-Path $tempRoot "extracted"
$modelDirectory = Join-Path $repoRoot "ai_engine\ml_models"

New-Item -ItemType Directory -Path $tempRoot | Out-Null
try {
    try {
        Invoke-WebRequest -Uri $ArchiveUrl -OutFile $archivePath -UseBasicParsing
    }
    catch {
        throw "Could not download model archive from '$ArchiveUrl': $($_.Exception.Message)"
    }

    $actualSha256 = (Get-FileHash -Path $archivePath -Algorithm SHA256).Hash
    if ($actualSha256 -ne $ExpectedSha256.ToUpperInvariant()) {
        throw "Model archive SHA-256 mismatch. Expected $($ExpectedSha256.ToUpperInvariant()), received $actualSha256. The archive was not extracted."
    }

    Expand-Archive -Path $archivePath -DestinationPath $extractPath
    $actualFiles = @(
        Get-ChildItem -Path $extractPath -File -Recurse |
            ForEach-Object {
                $_.FullName.Substring($extractPath.Length + 1).Replace("\", "/")
            } |
            Sort-Object
    )
    $sortedExpectedFiles = @($expectedFiles | Sort-Object)
    if (Compare-Object -ReferenceObject $sortedExpectedFiles -DifferenceObject $actualFiles) {
        throw "Model archive contents do not match the six expected active model artifacts. No files were installed."
    }

    $existingMismatches = @(
        foreach ($relativePath in $expectedFiles) {
            $sourcePath = Join-Path $extractPath ($relativePath.Replace("/", "\"))
            $destinationPath = Join-Path $repoRoot ($relativePath.Replace("/", "\"))
            if (Test-Path -LiteralPath $destinationPath -PathType Leaf) {
                $sourceHash = (Get-FileHash -Path $sourcePath -Algorithm SHA256).Hash
                $destinationHash = (Get-FileHash -Path $destinationPath -Algorithm SHA256).Hash
                if ($sourceHash -ne $destinationHash) {
                    $relativePath
                }
            }
        }
    )
    if ($existingMismatches.Count -gt 0) {
        throw "Refusing to overwrite existing model artifact(s) with different contents: $($existingMismatches -join ', '). Review or back up these files before retrying."
    }

    New-Item -ItemType Directory -Path $modelDirectory -Force | Out-Null
    foreach ($relativePath in $expectedFiles) {
        $sourcePath = Join-Path $extractPath ($relativePath.Replace("/", "\"))
        $destinationPath = Join-Path $repoRoot ($relativePath.Replace("/", "\"))
        if (-not (Test-Path -LiteralPath $destinationPath -PathType Leaf)) {
            Copy-Item -LiteralPath $sourcePath -Destination $destinationPath
        }
    }

    Write-Host "Installed and verified the six active HydroSync ML artifacts in '$modelDirectory'."
}
finally {
    if (Test-Path -LiteralPath $tempRoot) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force
    }
}
