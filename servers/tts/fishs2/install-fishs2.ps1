param(
  [string]$Python = "python"
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RuntimeDir = Join-Path $ScriptDir "fish-speech"
$VenvDir = Join-Path $ScriptDir ".venv"
$VenvPython = Join-Path $VenvDir "Scripts\python.exe"
$HfExe = Join-Path $VenvDir "Scripts\hf.exe"
$ModelDir = if ($env:FISH_S2_MODEL_DIR) { $env:FISH_S2_MODEL_DIR } else { Join-Path $RuntimeDir "checkpoints\fish-speech-s2-pro-int8" }
$RuntimeRepository = if ($env:FISH_S2_RUNTIME_REPOSITORY) { $env:FISH_S2_RUNTIME_REPOSITORY } else { "https://github.com/Imagilux/fish-speech.git" }
$RuntimeRef = if ($env:FISH_S2_RUNTIME_REF) { $env:FISH_S2_RUNTIME_REF } else { "2225e924e7d35cc0a1d24dbc67cd1819e6cf429f" }
$ModelId = if ($env:FISH_S2_MODEL_ID) { $env:FISH_S2_MODEL_ID } else { "Imagilux/fishaudio-s2-pro" }
$ModelRevision = if ($env:FISH_S2_MODEL_REVISION) { $env:FISH_S2_MODEL_REVISION } else { "9706ff036580881d87cc09465dd10014527bc481" }
$UpdateRuntime = $env:FISH_S2_UPDATE -match "^(1|true|yes|on)$"
if ($UpdateRuntime -and -not $env:FISH_S2_RUNTIME_REF) {
  $RuntimeRef = if ($env:FISH_S2_UPDATE_REF) { $env:FISH_S2_UPDATE_REF } else { "main" }
}
if ($UpdateRuntime -and -not $env:FISH_S2_MODEL_REVISION) {
  $ModelRevision = if ($env:FISH_S2_UPDATE_MODEL_REVISION) { $env:FISH_S2_UPDATE_MODEL_REVISION } else { "main" }
}

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  throw "git is required."
}
if (-not (Get-Command $Python -ErrorAction SilentlyContinue)) {
  throw "$Python was not found. Python 3.12 is recommended by Fish Speech."
}

if (-not (Test-Path (Join-Path $RuntimeDir ".git"))) {
  git clone --no-checkout $RuntimeRepository $RuntimeDir
}

git -C $RuntimeDir fetch --depth 1 origin $RuntimeRef
git -C $RuntimeDir checkout --detach --force $RuntimeRef

& $Python -m venv $VenvDir
& $VenvPython -m pip install --upgrade pip setuptools wheel
& $VenvPython -m pip install -r (Join-Path $ScriptDir "requirements.txt")
& $VenvPython -m pip install -e $RuntimeDir

if ($UpdateRuntime -or -not (Test-Path (Join-Path $ModelDir "model.pth")) -or -not (Test-Path (Join-Path $ModelDir "codec.pth"))) {
  Write-Host "Downloading $ModelId checkpoint at revision $ModelRevision..."
  Write-Host "If Hugging Face requests authentication, accept the model license and run: hf auth login"
  & $HfExe download $ModelId --revision $ModelRevision --local-dir $ModelDir
}

Write-Host "Fish S2 Pro setup complete."
Write-Host "Runtime: $RuntimeDir"
Write-Host "Runtime ref: $RuntimeRef"
Write-Host "Model:   $ModelDir"
Write-Host "Model ref: $ModelRevision"
Write-Host "Start:   $VenvPython $(Join-Path $ScriptDir 'server.py')"
Write-Warning "Fish Audio officially documents Linux/WSL for local S2 inference. Native Windows is best-effort; use WSL if upstream dependencies fail to build."
