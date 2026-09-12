$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RuntimeDir = if ($env:COSYVOICE3_RUNTIME_DIR) { $env:COSYVOICE3_RUNTIME_DIR } else { Join-Path $ScriptDir "CosyVoice" }
$ModelDir = if ($env:COSYVOICE3_MODEL_DIR) { $env:COSYVOICE3_MODEL_DIR } else { Join-Path $RuntimeDir "pretrained_models\Fun-CosyVoice3-0.5B" }
$ModelId = if ($env:COSYVOICE3_MODEL_ID) { $env:COSYVOICE3_MODEL_ID } else { "FunAudioLLM/Fun-CosyVoice3-0.5B-2512" }
$Python = if ($env:PYTHON) { $env:PYTHON } else { "python" }
$VenvDir = Join-Path $ScriptDir ".venv"
$VenvPython = Join-Path $VenvDir "Scripts\python.exe"

& $Python -c "import sys; assert sys.version_info[:2] == (3, 10), f'Python 3.10 is required by the current CosyVoice setup; found {sys.version.split()[0]}'"
if ($LASTEXITCODE -ne 0) { throw "CosyVoice setup requires Python 3.10." }

if (-not (Test-Path (Join-Path $RuntimeDir ".git"))) {
    Write-Host "Cloning the official CosyVoice runtime..."
    git clone --recursive https://github.com/QwenAudio/CosyVoice.git $RuntimeDir
    if ($LASTEXITCODE -ne 0) { throw "Failed to clone CosyVoice." }
} else {
    Write-Host "CosyVoice runtime already exists; refreshing submodules..."
    git -C $RuntimeDir submodule update --init --recursive
    if ($LASTEXITCODE -ne 0) { throw "Failed to update CosyVoice submodules." }
}

& $Python -m venv $VenvDir
& $VenvPython -m pip install --upgrade pip setuptools wheel
& $VenvPython -m pip install -r (Join-Path $RuntimeDir "requirements.txt")
& $VenvPython -m pip install -r (Join-Path $ScriptDir "requirements.txt")

$DownloadScript = @'
from pathlib import Path
import sys
from huggingface_hub import snapshot_download

model_id = sys.argv[1]
model_dir = Path(sys.argv[2])
model_dir.parent.mkdir(parents=True, exist_ok=True)
print(f"Downloading {model_id} to {model_dir} ...")
snapshot_download(repo_id=model_id, local_dir=str(model_dir))
'@

& $VenvPython -c $DownloadScript $ModelId $ModelDir
if ($LASTEXITCODE -ne 0) { throw "Failed to download the CosyVoice 3 model." }

Write-Host ""
Write-Host "CosyVoice 3 setup complete."
Write-Host ""
Write-Host "Native Windows is best-effort because the current upstream requirements use CPU ONNX Runtime on Windows."
Write-Host "For the lowest-latency NVIDIA setup, WSL2/Linux is recommended."
Write-Host ""
Write-Host "Start only the sidecar:"
Write-Host "  $VenvPython $ScriptDir\server.py"
Write-Host ""
Write-Host "Or start it with TomoriBot from the repository root:"
Write-Host "  bun run launch --cosyvoice3"
Write-Host ""
Write-Host "Default endpoint: http://127.0.0.1:8016"
