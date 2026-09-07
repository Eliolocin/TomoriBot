$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Backend = if ($args.Count -gt 0) { $args[0] } else { "cu128" }
$ValidBackends = @("cu128", "cpu", "rocm", "xpu")

if ($ValidBackends -notcontains $Backend) {
    Write-Error "Unknown backend '$Backend'. Expected one of: $($ValidBackends -join ', ')."
    exit 1
}

if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
    Write-Error "uv is required. Install it from https://docs.astral.sh/uv/ and run this script again."
    exit 1
}

Push-Location $ScriptDir
try {
    Write-Host "Installing Irodori-TTS sidecar dependencies with backend '$Backend'..."
    uv sync --extra $Backend
    if ($LASTEXITCODE -ne 0) {
        throw "uv sync failed with exit code $LASTEXITCODE."
    }

    Write-Host "Irodori-TTS sidecar installed successfully."
    Write-Host "Virtual environment: $ScriptDir\.venv"
} finally {
    Pop-Location
}
