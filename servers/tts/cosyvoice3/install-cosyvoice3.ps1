$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RuntimeDir = if ($env:COSYVOICE3_RUNTIME_DIR) { $env:COSYVOICE3_RUNTIME_DIR } else { Join-Path $ScriptDir "CosyVoice" }
$ModelDir = if ($env:COSYVOICE3_MODEL_DIR) { $env:COSYVOICE3_MODEL_DIR } else { Join-Path $RuntimeDir "pretrained_models\Fun-CosyVoice3-0.5B" }
$ModelId = if ($env:COSYVOICE3_MODEL_ID) { $env:COSYVOICE3_MODEL_ID } else { "FunAudioLLM/Fun-CosyVoice3-0.5B-2512" }
$RuntimeRepo = if ($env:COSYVOICE3_RUNTIME_REPO) { $env:COSYVOICE3_RUNTIME_REPO } else { "https://github.com/QwenAudio/CosyVoice.git" }
$RuntimeCommit = if ($env:COSYVOICE3_RUNTIME_COMMIT) { $env:COSYVOICE3_RUNTIME_COMMIT } else { "074ca6dc9e80a2f424f1f74b48bdd7d3fea531cc" }
$ModelRevision = if ($env:COSYVOICE3_MODEL_REVISION) { $env:COSYVOICE3_MODEL_REVISION } else { "29e01c4e8d000f4bcd70751be16fa94bf3d85a18" }
$AllowUpdate = $env:COSYVOICE3_UPDATE -eq "1"
$Python = if ($env:PYTHON) { $env:PYTHON } else { "python" }
$VenvDir = Join-Path $ScriptDir ".venv"
$VenvPython = Join-Path $VenvDir "Scripts\python.exe"
$InstallMetadata = Join-Path $ModelDir ".tomoribot-cosyvoice3-install.json"

& $Python -c "import sys; assert sys.version_info[:2] == (3, 10), f'Python 3.10 is required by the current CosyVoice setup; found {sys.version.split()[0]}'"
if ($LASTEXITCODE -ne 0) { throw "CosyVoice setup requires Python 3.10." }

if (-not (Test-Path (Join-Path $RuntimeDir ".git"))) {
    Write-Host "Cloning the pinned CosyVoice runtime revision $RuntimeCommit..."
    git clone --recursive $RuntimeRepo $RuntimeDir
    if ($LASTEXITCODE -ne 0) { throw "Failed to clone CosyVoice." }
    git -C $RuntimeDir fetch --no-tags origin $RuntimeCommit
    if ($LASTEXITCODE -ne 0) { throw "Failed to fetch CosyVoice revision $RuntimeCommit." }
    git -C $RuntimeDir checkout --detach $RuntimeCommit
    if ($LASTEXITCODE -ne 0) { throw "Failed to select CosyVoice revision $RuntimeCommit." }
} else {
    $Dirty = git -C $RuntimeDir status --porcelain
    if ($Dirty) { throw "CosyVoice runtime has local changes. Clean it before reinstalling." }
    $CurrentCommit = (git -C $RuntimeDir rev-parse HEAD).Trim()
    if ($CurrentCommit -ne $RuntimeCommit) {
        if (-not $AllowUpdate) {
            throw "CosyVoice runtime is at $CurrentCommit, expected $RuntimeCommit. Set COSYVOICE3_UPDATE=1 to explicitly switch the checkout."
        }
        git -C $RuntimeDir fetch --no-tags origin $RuntimeCommit
        if ($LASTEXITCODE -ne 0) { throw "Failed to fetch CosyVoice revision $RuntimeCommit." }
        git -C $RuntimeDir checkout --detach $RuntimeCommit
        if ($LASTEXITCODE -ne 0) { throw "Failed to select CosyVoice revision $RuntimeCommit." }
    }
}
git -C $RuntimeDir submodule sync --recursive
if ($LASTEXITCODE -ne 0) { throw "Failed to sync CosyVoice submodules." }
git -C $RuntimeDir submodule update --init --recursive
if ($LASTEXITCODE -ne 0) { throw "Failed to update CosyVoice submodules." }

& $Python -m venv $VenvDir
& $VenvPython -m pip install --upgrade pip setuptools wheel
& $VenvPython -m pip install -r (Join-Path $RuntimeDir "requirements.txt")
& $VenvPython -m pip install -r (Join-Path $ScriptDir "requirements.txt")

$DownloadScript = @'
import json
from pathlib import Path
import sys
from huggingface_hub import snapshot_download

model_id = sys.argv[1]
model_dir = Path(sys.argv[2])
revision = sys.argv[3]
metadata_path = Path(sys.argv[4])
allow_update = sys.argv[5] == "1"
model_dir.parent.mkdir(parents=True, exist_ok=True)
expected = {"model_id": model_id, "model_revision": revision}
if metadata_path.is_file():
    current = json.loads(metadata_path.read_text(encoding="utf-8"))
    if current != expected and not allow_update:
        raise SystemExit(
            f"CosyVoice model metadata is {current}, expected {expected}. "
            "Set COSYVOICE3_UPDATE=1 to explicitly refresh it."
        )
print(f"Downloading {model_id}@{revision} to {model_dir} ...")
snapshot_download(repo_id=model_id, revision=revision, local_dir=str(model_dir))
metadata_path.write_text(json.dumps(expected, sort_keys=True) + "\n", encoding="utf-8")
'@

& $VenvPython -c $DownloadScript $ModelId $ModelDir $ModelRevision $InstallMetadata $(if ($AllowUpdate) { "1" } else { "0" })
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
Write-Host "Default endpoint: http://127.0.0.1:8017"
Write-Host "Pinned runtime: $RuntimeCommit"
Write-Host "Pinned model revision: $ModelRevision"
Write-Host "Set COSYVOICE3_UPDATE=1 with an explicit pin override to update this installation."
