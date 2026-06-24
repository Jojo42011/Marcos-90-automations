# Start VoxCPM service locally (mock mode on CPU — tests full Node pipeline)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$vcRoot = Join-Path $root "data\voice-clone"
$refDir = Join-Path $vcRoot "reference"
$genDir = Join-Path $vcRoot "generated"
$expDir = Join-Path $vcRoot "exports"
New-Item -ItemType Directory -Force -Path $refDir, $genDir, $expDir | Out-Null

$refWav = Join-Path $refDir "marco-dev-reference.wav"
if (-not (Test-Path $refWav)) {
  Write-Host "Creating placeholder reference WAV at $refWav"
  python -c @"
import numpy as np, soundfile as sf
sr = 24000
t = np.linspace(0, 2.0, int(sr * 2), endpoint=False)
wav = 0.08 * np.sin(2 * np.pi * 200 * t)
sf.write(r'$refWav', wav, sr)
"@
}

$env:VOXCPM_MOCK = "1"
$env:VOXCPM_OUTPUT_DIR = $genDir
$port = if ($env:VOXCPM_PORT) { $env:VOXCPM_PORT } else { "8001" }

Write-Host "VoxCPM local mock service -> http://localhost:$port"
Write-Host "Set VOXCPM_API_URL=http://localhost:$port in .env"
Set-Location (Join-Path $root "voxcpm-service")
python -m uvicorn server:app --host 0.0.0.0 --port $port
