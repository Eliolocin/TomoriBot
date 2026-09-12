param(
  [string]$Python = "python"
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RuntimeDir = Join-Path $ScriptDir "fish-speech"
$VenvDir = Join-Path $ScriptDir ".venv"
$VenvPython = Join-Path $VenvDir "Scripts\python.exe"
$HfExe = Join-Path $VenvDir "Scripts\hf.exe"
$ModelDir = Join-Path $RuntimeDir "checkpoints\fish-speech-s2-pro-int8"

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  throw "git is required."
}
if (-not (Get-Command $Python -ErrorAction SilentlyContinue)) {
  throw "$Python was not found. Python 3.12 is recommended by Fish Speech."
}

if (-not (Test-Path (Join-Path $RuntimeDir ".git"))) {
  git clone https://github.com/Imagilux/fish-speech.git $RuntimeDir
} else {
  git -C $RuntimeDir pull --ff-only
}

& $Python -m venv $VenvDir
& $VenvPython -m pip install --upgrade pip setuptools wheel
& $VenvPython -m pip install -r (Join-Path $ScriptDir "requirements.txt")
& $VenvPython -m pip install -e $RuntimeDir

if (-not (Test-Path (Join-Path $ModelDir "model.pth")) -or -not (Test-Path (Join-Path $ModelDir "codec.pth"))) {
  Write-Host "Downloading Imagilux/fishaudio-s2-pro INT8 checkpoint..."
  Write-Host "If Hugging Face requests authentication, accept the model license and run: hf auth login"
  & $HfExe download Imagilux/fishaudio-s2-pro --local-dir $ModelDir
}

Write-Host "Fish S2 Pro setup complete."
Write-Host "Runtime: $RuntimeDir"
Write-Host "Model:   $ModelDir"
Write-Host "Start:   $VenvPython $(Join-Path $ScriptDir 'server.py')"
Write-Warning "Fish Audio officially documents Linux/WSL for local S2 inference. Native Windows is best-effort; use WSL if upstream dependencies fail to build."
