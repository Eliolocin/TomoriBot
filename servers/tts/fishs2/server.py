from __future__ import annotations

import atexit
import base64
import binascii
import hmac
import io
import ipaddress
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
import wave
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

import ormsgpack
import uvicorn
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import Response
from pydantic import BaseModel


ROOT = Path(__file__).resolve().parent
FISH_SPEECH_DIR = Path(os.getenv("FISH_SPEECH_DIR", ROOT / "fish-speech")).resolve()
MODEL_DIR = Path(
    os.getenv(
        "FISH_S2_MODEL_DIR",
        FISH_SPEECH_DIR / "checkpoints" / "fish-speech-s2-pro-int8",
    )
).resolve()

HOST = os.getenv("TOMORI_TTS_HOST", "127.0.0.1")
PORT = int(os.getenv("FISH_S2_PORT", os.getenv("TOMORI_TTS_PORT", "8015")))
UPSTREAM_HOST = os.getenv("FISH_S2_UPSTREAM_HOST", "127.0.0.1")
UPSTREAM_PORT = int(os.getenv("FISH_S2_UPSTREAM_PORT", "8025"))
UPSTREAM_URL = f"http://{UPSTREAM_HOST}:{UPSTREAM_PORT}"
MAX_TEXT_CHARS = int(os.getenv("TOMORI_TTS_MAX_TEXT_CHARS", "2000"))
MAX_REFERENCE_AUDIO_BYTES = int(
    os.getenv("FISH_S2_MAX_REF_AUDIO_BYTES", os.getenv("TOMORI_TTS_MAX_REF_AUDIO_BYTES", str(10 * 1024 * 1024)))
)
STARTUP_TIMEOUT_SECONDS = float(os.getenv("FISH_S2_STARTUP_TIMEOUT_SECONDS", "180"))
SYNTHESIS_TIMEOUT_SECONDS = float(os.getenv("FISH_S2_SYNTHESIS_TIMEOUT_SECONDS", "240"))
COMPILE = os.getenv("FISH_S2_COMPILE", "0").lower() in {"1", "true", "yes", "on"}
HALF = os.getenv("FISH_S2_HALF", "0").lower() in {"1", "true", "yes", "on"}
MODEL_ID = os.getenv("FISH_S2_MODEL_ID", "Imagilux/fishaudio-s2-pro")
API_KEY = (os.getenv("FISH_S2_API_KEY") or os.getenv("TOMORI_TTS_API_KEY") or "").strip()
ALLOW_INSECURE_REMOTE = os.getenv("FISH_S2_ALLOW_INSECURE_REMOTE", "0").lower() in {
    "1",
    "true",
    "yes",
    "on",
}

CHUNK_LENGTH = int(os.getenv("FISH_S2_CHUNK_LENGTH", "200"))
TOP_P = float(os.getenv("FISH_S2_TOP_P", "0.8"))
TEMPERATURE = float(os.getenv("FISH_S2_TEMPERATURE", "0.8"))
REPETITION_PENALTY = float(os.getenv("FISH_S2_REPETITION_PENALTY", "1.1"))
MAX_NEW_TOKENS = int(os.getenv("FISH_S2_MAX_NEW_TOKENS", "1024"))
USE_MEMORY_CACHE = os.getenv("FISH_S2_USE_MEMORY_CACHE", "on")

fish_process: subprocess.Popen[bytes] | None = None


class SynthesizeRequest(BaseModel):
    text: str
    ref_audio: str
    ref_text: Optional[str] = None
    instruct: Optional[str] = None
    language: Optional[str] = None


def is_loopback_host(host: str) -> bool:
    normalized = host.strip().lower()
    if normalized == "localhost":
        return True
    try:
        return ipaddress.ip_address(normalized).is_loopback
    except ValueError:
        return False


def validate_bind_policy() -> None:
    if not is_loopback_host(HOST) and not API_KEY and not ALLOW_INSECURE_REMOTE:
        raise RuntimeError(
            "Fish S2 remote binding requires FISH_S2_API_KEY or "
            "FISH_S2_ALLOW_INSECURE_REMOTE=1. Keep TOMORI_TTS_HOST on loopback when possible."
        )


def authorize_request(request: Request | None) -> None:
    if not API_KEY:
        return
    authorization = request.headers.get("authorization", "") if request is not None else ""
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not hmac.compare_digest(token, API_KEY):
        raise HTTPException(
            status_code=401,
            detail="A valid bearer token is required.",
            headers={"WWW-Authenticate": "Bearer"},
        )


def require_installation() -> None:
    api_server = FISH_SPEECH_DIR / "tools" / "api_server.py"
    codec = MODEL_DIR / "codec.pth"
    if not api_server.is_file():
        raise RuntimeError(
            f"Fish Speech runtime not found at {FISH_SPEECH_DIR}. "
            "Run the Fish S2 setup instructions first."
        )
    if not codec.is_file():
        raise RuntimeError(
            f"Fish S2 Pro checkpoint not found at {MODEL_DIR}. "
            f"Download {MODEL_ID} before starting the sidecar."
        )


def wait_for_upstream() -> None:
    deadline = time.monotonic() + STARTUP_TIMEOUT_SECONDS
    health_url = f"{UPSTREAM_URL}/v1/health"
    while time.monotonic() < deadline:
        if fish_process is not None and fish_process.poll() is not None:
            raise RuntimeError(f"Fish Speech API exited during startup with code {fish_process.returncode}.")
        try:
            with urllib.request.urlopen(health_url, timeout=2) as response:
                if 200 <= response.status < 300:
                    return
        except (urllib.error.URLError, TimeoutError):
            pass
        time.sleep(1)
    raise RuntimeError(f"Fish Speech API did not become ready within {STARTUP_TIMEOUT_SECONDS:.0f}s.")


def start_fish_api() -> None:
    global fish_process
    validate_bind_policy()
    require_installation()

    command = [
        sys.executable,
        str(FISH_SPEECH_DIR / "tools" / "api_server.py"),
        "--llama-checkpoint-path",
        str(MODEL_DIR),
        "--decoder-checkpoint-path",
        str(MODEL_DIR / "codec.pth"),
        "--listen",
        f"{UPSTREAM_HOST}:{UPSTREAM_PORT}",
        "--workers",
        "1",
    ]
    if COMPILE:
        command.append("--compile")
    if HALF:
        command.append("--half")

    fish_process = subprocess.Popen(command, cwd=FISH_SPEECH_DIR)
    wait_for_upstream()


def stop_fish_api() -> None:
    global fish_process
    if fish_process is None or fish_process.poll() is not None:
        return
    fish_process.terminate()
    try:
        fish_process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        fish_process.kill()
        fish_process.wait(timeout=5)
    fish_process = None


atexit.register(stop_fish_api)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    start_fish_api()
    try:
        yield
    finally:
        stop_fish_api()


app = FastAPI(title="TomoriBot Fish Audio S2 Pro TTS Server", lifespan=lifespan)


@app.get("/health")
def health(request: Request) -> dict[str, str | bool]:
    authorize_request(request)
    running = fish_process is not None and fish_process.poll() is None
    return {
        "status": "ok" if running else "loading",
        "model": MODEL_ID,
        "model_family": "Fish Audio S2 Pro",
        "model_dir": str(MODEL_DIR),
        "runtime": "Imagilux/fish-speech",
        "compile": COMPILE,
        "half": HALF,
        "supports_bracket_tags": True,
    }


def validate_wav_container(audio: bytes) -> None:
    if len(audio) < 12 or audio[:4] != b"RIFF" or audio[8:12] != b"WAVE":
        raise HTTPException(status_code=400, detail="ref_audio must be a RIFF/WAVE container.")

    declared_size = int.from_bytes(audio[4:8], "little") + 8
    if declared_size > len(audio):
        raise HTTPException(status_code=400, detail="ref_audio contains a truncated WAV container.")

    try:
        with wave.open(io.BytesIO(audio), "rb") as wav_file:
            if wav_file.getcomptype() != "NONE":
                raise HTTPException(status_code=400, detail="ref_audio must contain uncompressed PCM audio.")
            if wav_file.getnchannels() < 1 or wav_file.getframerate() < 1 or wav_file.getsampwidth() < 1:
                raise HTTPException(status_code=400, detail="ref_audio has invalid WAV audio parameters.")
            if wav_file.getnframes() < 1:
                raise HTTPException(status_code=400, detail="ref_audio must contain at least one audio frame.")
            expected_bytes = wav_file.getnframes() * wav_file.getnchannels() * wav_file.getsampwidth()
            if len(wav_file.readframes(wav_file.getnframes())) < expected_bytes:
                raise HTTPException(status_code=400, detail="ref_audio contains truncated PCM data.")
    except HTTPException:
        raise
    except (EOFError, OSError, ValueError, wave.Error) as exc:
        raise HTTPException(status_code=400, detail="ref_audio is not a valid PCM WAV file.") from exc


def decode_reference_audio(raw_base64: str) -> bytes:
    max_encoded_length = ((MAX_REFERENCE_AUDIO_BYTES + 2) // 3) * 4
    if len(raw_base64) > max_encoded_length:
        raise HTTPException(
            status_code=413,
            detail=f"ref_audio exceeds the {MAX_REFERENCE_AUDIO_BYTES} byte limit.",
        )
    try:
        audio = base64.b64decode(raw_base64, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise HTTPException(status_code=400, detail="ref_audio must be valid base64.") from exc
    if not audio:
        raise HTTPException(status_code=400, detail="ref_audio must not be empty.")
    if len(audio) > MAX_REFERENCE_AUDIO_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"ref_audio exceeds the {MAX_REFERENCE_AUDIO_BYTES} byte limit.",
        )
    validate_wav_container(audio)
    return audio


@app.post("/synthesize")
def synthesize(payload: SynthesizeRequest, request: Request) -> Response:
    authorize_request(request)
    if fish_process is None or fish_process.poll() is not None:
        raise HTTPException(status_code=503, detail="Fish Speech runtime is not ready.")

    text = payload.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="text is required.")
    if len(text) > MAX_TEXT_CHARS:
        raise HTTPException(status_code=400, detail=f"text exceeds {MAX_TEXT_CHARS} characters.")
    if not payload.ref_audio.strip():
        raise HTTPException(status_code=400, detail="ref_audio is required for Fish S2 Pro voice cloning.")

    reference_audio = decode_reference_audio(payload.ref_audio)
    reference_text = payload.ref_text.strip() if payload.ref_text else ""

    request_data = {
        "text": text,
        "references": [{"audio": reference_audio, "text": reference_text}],
        "reference_id": None,
        "format": "wav",
        "latency": "normal",
        "max_new_tokens": MAX_NEW_TOKENS,
        "chunk_length": CHUNK_LENGTH,
        "top_p": TOP_P,
        "repetition_penalty": REPETITION_PENALTY,
        "temperature": TEMPERATURE,
        "streaming": False,
        "use_memory_cache": USE_MEMORY_CACHE,
        "seed": None,
    }

    packed = ormsgpack.packb(request_data)
    request = urllib.request.Request(
        f"{UPSTREAM_URL}/v1/tts?format=msgpack",
        data=packed,
        headers={"Content-Type": "application/msgpack"},
        method="POST",
    )

    try:
        with urllib.request.urlopen(request, timeout=SYNTHESIS_TIMEOUT_SECONDS) as response:
            audio = response.read()
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise HTTPException(status_code=502, detail=f"Fish Speech synthesis failed: {detail}") from exc
    except (urllib.error.URLError, TimeoutError) as exc:
        raise HTTPException(status_code=502, detail=f"Fish Speech runtime unavailable: {exc}") from exc

    if not audio:
        raise HTTPException(status_code=502, detail="Fish Speech returned an empty audio response.")
    return Response(content=audio, media_type="audio/wav")


if __name__ == "__main__":
    uvicorn.run(app, host=HOST, port=PORT)
